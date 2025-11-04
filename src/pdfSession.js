/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2024 Corporation for Digital Scholarship
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

const { jar: cookieJar } = require('request');
const { firefox } = require('playwright');
const Translate = require('./translation/translate');

const PRIMARY_ATTACHMENT_TYPES = new Set([
	'application/pdf',
	'application/epub+zip',
]);

var PDFSession = module.exports = function (ctx, next) {
	this.ctx = ctx;
	this.next = next;
};

/**
 * Handle items from /web endpoint - find and download PDF
 * @return {Promise<undefined>}
 */
PDFSession.prototype.handleItems = async function (items) {
	if (!Array.isArray(items) || items.length === 0) {
		this.ctx.throw(400, "Items array is empty or invalid\n");
	}
	
	// Initialize cookie sandbox for PDF downloads
	this._cookieSandbox = cookieJar();
	
	// Find PDF attachment and item with DOI for Unpaywall
	let pdfAttachment = null;
	let itemWithDOI = null;
	
	for (let item of items) {
		// Track item with DOI for Unpaywall fallback
		if (item.DOI && !itemWithDOI) {
			itemWithDOI = item;
		}
		
		// Look for PDF attachments
		if (item.attachments && item.attachments.length > 0) {
			for (let attachment of item.attachments) {
				if (PRIMARY_ATTACHMENT_TYPES.has(attachment.mimeType)) {
					pdfAttachment = attachment;
					break;
				}
			}
			if (pdfAttachment) break;
		}
	}
	
	// If no PDF found from items, try Unpaywall
	if (!pdfAttachment && itemWithDOI) {
		pdfAttachment = await this.findPDFViaUnpaywall(itemWithDOI);
	}
	
	if (!pdfAttachment) {
		this.ctx.throw(501, "No PDF attachment found in provided items\n");
		return;
	}
	
	// Download and return the PDF using Playwright
	await this.downloadPDFWithPlaywright(pdfAttachment);
};

/**
 * Download a PDF using Playwright (handles bot protection)
 * @param {Object} pdfAttachment - Attachment object with url, title, mimeType
 * @return {Promise<undefined>}
 */
PDFSession.prototype.downloadPDFWithPlaywright = async function (pdfAttachment) {
	let browser = null;
	try {
		let pdfURL = pdfAttachment.url;
		Zotero.debug(`Fetching PDF with Playwright from ${pdfURL}`);
		
		// Launch headless Firefox
		browser = await firefox.launch({ headless: true });
		
		// Create a context that allows downloads
		const context = await browser.newContext({
			acceptDownloads: true
		});
		
		const page = await context.newPage();
		
		// Navigate and wait for download
		const [download] = await Promise.all([
			page.waitForEvent('download', { timeout: 60000 }),
			page.goto(pdfURL, { timeout: 60000 })
		]);
		
		// Get the downloaded file as a buffer
		const stream = await download.createReadStream();
		const chunks = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
		}
		const buffer = Buffer.concat(chunks);
		
		// Verify it's a PDF
		const header = buffer.slice(0, 5).toString('utf8');
		if (!header.startsWith('%PDF')) {
			throw new Error(`Downloaded file is not a PDF (starts with: ${header})`);
		}
		
		// Return the PDF
		this.ctx.response.status = 200;
		this.ctx.response.set('Content-Type', 'application/pdf');
		if (pdfAttachment.title) {
			// Sanitize filename: remove path components, special chars, and limit length
			let filename = pdfAttachment.title
				.replace(/[/\\]/g, '') // Remove path separators
				.replace(/\.\./g, '') // Remove parent directory references
				.replace(/[^a-zA-Z0-9_\-. ]/g, '_') // Replace special chars
				.substring(0, 200); // Limit length
			if (!filename.endsWith('.pdf')) {
				filename += '.pdf';
			}
			this.ctx.response.set('Content-Disposition', `attachment; filename="${filename}"`);
		}
		
		this.ctx.response.body = buffer;
	}
	catch (e) {
		Zotero.debug("Error fetching PDF with Playwright: " + e, 1);
		this.ctx.throw(500, "Failed to fetch PDF: " + e.message);
	}
	finally {
		if (browser) {
			await browser.close();
		}
	}
};

/**
 * Try to find open-access PDF via Unpaywall by trying all OA locations
 * @param {Object} item - Item with DOI
 * @return {Promise<Object|null>} - PDF attachment object or null
 */
PDFSession.prototype.findPDFViaUnpaywall = async function (item) {
	if (!item.DOI) return null;
	
	let doi = Zotero.Utilities.cleanDOI(item.DOI);
	if (!doi) return null;
	
	Zotero.debug(`Trying Unpaywall for DOI: ${doi}`);
	
	// Get email for Unpaywall API
	let email = await this.getUnpaywallEmail();
	if (!email) {
		Zotero.debug("No email configured for Unpaywall API");
		return null;
	}
	
	try {
		let url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
		let response = await Zotero.HTTP.request(
			"GET",
			url,
			{
				timeout: 10000,
				responseType: 'json',
				successCodes: [200, 404] // 404 is OK, just means not found
			}
		);
		
		if (response.status === 404) {
			Zotero.debug("No open-access PDF found via Unpaywall");
			return null;
		}
		
		let data = response.response;
		
		// Try all OA locations, not just the best one
		let oaLocations = data.oa_locations || [];
		if (oaLocations.length === 0) {
			Zotero.debug("No OA locations in Unpaywall response");
			return null;
		}
		
		Zotero.debug(`Found ${oaLocations.length} OA locations from Unpaywall`);
		
		// Try each OA location
		for (let location of oaLocations) {
			Zotero.debug(`Trying OA location: ${location.url_for_landing_page || location.url}`);
			
			// If there's a direct PDF URL, try it first
			if (location.url_for_pdf) {
				Zotero.debug(`Found direct PDF URL: ${location.url_for_pdf}`);
				return {
					url: location.url_for_pdf,
					title: item.title || 'Unpaywall PDF',
					mimeType: 'application/pdf'
				};
			}
			
			// Otherwise, try the landing page with /web endpoint to get attachments
			let landingPage = location.url_for_landing_page || location.url;
			if (landingPage) {
				try {
					Zotero.debug(`Trying landing page via /web: ${landingPage}`);
					let webItems = await this.getItemsFromURL(landingPage);
					
					// Check if we got items with PDF attachments
					if (webItems && webItems.length > 0) {
						for (let webItem of webItems) {
							if (webItem.attachments && webItem.attachments.length > 0) {
								for (let attachment of webItem.attachments) {
									if (PRIMARY_ATTACHMENT_TYPES.has(attachment.mimeType)) {
										Zotero.debug(`Found PDF attachment via /web: ${attachment.url}`);
										return attachment;
									}
								}
							}
						}
					}
				}
				catch (e) {
					Zotero.debug(`Failed to get items from ${landingPage}: ${e.message}`);
					// Continue to next location
				}
			}
		}
		
		Zotero.debug("No usable PDF found from any Unpaywall OA location");
		return null;
	}
	catch (e) {
		Zotero.debug(`Unpaywall request failed: ${e.message}`, 1);
		return null;
	}
};

/**
 * Get items from a URL using translator
 * @param {string} url - URL to translate
 * @return {Promise<Array>} - Array of items
 */
PDFSession.prototype.getItemsFromURL = async function (url) {
	try {
		let translate = new Translate.Web();
		translate.setCookieSandbox(this._cookieSandbox);
		
		// Fetch the page
		let req = await Zotero.HTTP.request(
			"GET",
			url,
			{
				responseType: 'document',
				cookieSandbox: this._cookieSandbox
			}
		);
		
		translate.setDocument(req.response);
		
		// Get translators
		let translators = await translate.getTranslators(true);
		if (!translators || translators.length === 0) {
			Zotero.debug("No translators found for " + url);
			return null;
		}
		
		// Try first translator
		translate.setTranslator(translators[0]);
		let items = await translate.translate({
			libraryID: false
		});
		
		return items;
	}
	catch (e) {
		Zotero.debug(`Error translating URL ${url}: ${e.message}`);
		return null;
	}
};

/**
 * Get email address for Unpaywall API
 * First checks UNPAYWALL_EMAIL env var, then falls back to git config user.email
 * @return {Promise<string|null>}
 */
PDFSession.prototype.getUnpaywallEmail = async function () {
	// Check environment variable first
	// eslint-disable-next-line no-process-env
	if (process.env.UNPAYWALL_EMAIL) {
		// eslint-disable-next-line no-process-env
		return process.env.UNPAYWALL_EMAIL;
	}
	
	// Fallback to git config user.email
	try {
		const { execSync } = require('child_process');
		let email = execSync('git config user.email', { encoding: 'utf8' }).trim();
		if (email) {
			return email;
		}
	}
	catch (e) {
		Zotero.debug("Could not get git user.email: " + e.message);
	}
	
	return null;
};
