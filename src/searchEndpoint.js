/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2018 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://www.zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

const config = require('config');
const Translate = require('./translation/translate');
const TextSearch = require('./textSearch');
const { firefox } = require('playwright');
const { JSDOM } = require('jsdom');

var SearchEndpoint = module.exports = {
	handle: async function (ctx, next) {
		ctx.assert(ctx.is('text'), 415);
		
		var data = ctx.request.body;
		
		if (!data) {
			ctx.throw(400, "POST data not provided\n");
		}
		
		// Look for DOI, ISBN, etc.
		var identifiers = Zotero.Utilities.extractIdentifiers(data);
		
		// Use PMID only if it's the only text in the query, with or without a pmid: prefix
		if (identifiers.length && identifiers[0].PMID
				&& identifiers[0].PMID !== data.replace(/^\s*(?:pmid:)?([0-9]+)\s*$/, '$1')) {
			identifiers = [];
		}
		
		// Text search
		if (!identifiers.length) {
			await TextSearch.handle(ctx, next);
			return;
		}
		
		await this.handleIdentifier(ctx, identifiers[0]);
	},
	
	
	handleIdentifier: async function (ctx, identifier, retriedWithPlaywright = false) {
		// Identifier
		try {
			var translate = new Translate.Search();
			translate.setIdentifier(identifier);
			let translators = await translate.getTranslators();
			if (!translators.length) {
				ctx.throw(501, "No translators available", { expose: true });
			}
			translate.setTranslator(translators);
			
			var items = await translate.translate({
				libraryID: false
			});
		}
		catch (e) {
			if (e == translate.ERROR_NO_RESULTS) {
				ctx.throw(501, e, { expose: true });
			}
			
			Zotero.debug(e, 1);
			ctx.throw(
				500,
				"An error occurred during translation. "
					+ "Please check translation with the Zotero client.",
				{ expose: true }
			);
		}
		
		// Check if any items have attachments
		let hasAttachments = items.some(item => item.attachments && item.attachments.length > 0);
		
		// If no attachments and items have URLs, retry with Playwright for full DOM
		if (!hasAttachments && !retriedWithPlaywright) {
			for (let item of items) {
				if (item.url) {
					Zotero.debug(`No attachments found from identifier search, retrying with Playwright for URL: ${item.url}`);
					try {
						const playwrightItems = await this.retryWithPlaywright(item.url);
						if (playwrightItems && playwrightItems.length > 0) {
							items = playwrightItems;
							break;
						}
					}
					catch (e) {
						Zotero.debug("Playwright retry failed: " + e.message, 1);
						// Continue with original results
					}
				}
			}
		}
		
		// Translation can return multiple items (e.g., a parent item and notes pointing to it),
		// so we have to return an array with keyed items
		var json = [];
		for (let item of items) {
			let apiItems = Zotero.Utilities.Item.itemToAPIJSON(item);
			// Preserve attachments from original item for PDF endpoint
			for (let apiItem of apiItems) {
				apiItem.attachments = item.attachments;
			}
			json.push(...apiItems);
		}
		
		ctx.response.body = json;
	},
	
	/**
	 * Retry translation with Playwright to get full browser-rendered DOM
	 * This helps translators that need to see dynamically-loaded PDF links
	 *
	 * @param {String} url - The URL to fetch
	 * @return {Promise<Array>} - Array of items with attachments
	 */
	retryWithPlaywright: async function (url) {
		let browser;
		try {
			browser = await firefox.launch({ headless: true });
			const context = await browser.newContext();
			const page = await context.newPage();
			
			// Navigate to the page
			await page.goto(url, {
				waitUntil: 'networkidle',
				timeout: 15000
			});
			
			// Get the HTML content
			const html = await page.content();
			
			await browser.close();
			browser = null;
			
			// Parse the HTML into a DOM document using JSDOM
			const dom = new JSDOM(html, { url: url });
			const document = dom.window.document;
			
			// Create a new translator with the browser-rendered document
			let translate = new Translate.Web();
			translate.setDocument(document);
			
			// Get translators for this document
			let translators = await translate.getTranslators();
			if (!translators.length) {
				throw new Error("No translators found for Playwright-rendered page");
			}
			
			// Try translators until we find one with attachments
			for (let translator of translators) {
				translate.setTranslator(translator);
				try {
					let items = await translate.translate({
						libraryID: false
					});
					
					if (items && items.length > 0) {
						let hasAttachments = items.some(item => item.attachments && item.attachments.length > 0);
						if (hasAttachments) {
							Zotero.debug("Playwright retry successful, found attachments");
							return items;
						}
					}
				}
				catch (e) {
					Zotero.debug("Translation using " + translator.label + " failed in Playwright retry", 1);
					// Try next translator
				}
			}
			
			throw new Error("Playwright retry did not find attachments");
		}
		catch (e) {
			if (browser) {
				await browser.close().catch(() => {});
			}
			throw e;
		}
	}
};
