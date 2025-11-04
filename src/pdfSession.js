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

const config = require('config');
const Translate = require('./translation/translate');
const { jar: cookieJar } = require('request');

const FORWARDED_HEADERS = ['Accept-Language'];
const PRIMARY_ATTACHMENT_TYPES = new Set([
	'application/pdf',
	'application/epub+zip',
]);

var PDFSession = module.exports = function (ctx, next, url) {
	this.ctx = ctx;
	this.next = next;
	this.url = url;
};

/**
 * @return {Promise<undefined>}
 */
PDFSession.prototype.handleURL = async function () {
	var url = this.url;
	
	// Forward supported headers
	var headers = {};
	for (let header of FORWARDED_HEADERS) {
		let lc = header.toLowerCase();
		if (this.ctx.headers[lc]) {
			headers[header] = this.ctx.headers[lc];
		}
	}
	
	try {
		// Parse and validate URL - will throw if invalid
		let parsedURL = new URL(url);
		// Basic validation that it's http/https
		if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
			throw new Error('Invalid protocol');
		}
	}
	catch (e) {
		this.ctx.throw(400, "Invalid URL provided\n");
	}
	
	// Check domain
	var m = url.match(/https?:\/\/([^/]+)/);
	if (m) {
		let domain = m[1];
		let blacklisted = config.get("blacklistedDomains")
			.some(x => x && new RegExp(x).test(domain));
		if (blacklisted) {
			this.ctx.throw(500, "Domain is blacklisted\n");
		}
	}
	
	// New request
	this._cookieSandbox = cookieJar();
	
	let resolve;
	let reject;
	let promise = new Promise(function () {
		resolve = arguments[0];
		reject = arguments[1];
	});
	
	let translate = new Translate.Web();
	let translatePromise;
	translate.setHandler("translators", async function (translate, translators) {
		try {
			translatePromise = this.translate(translate, translators);
			await translatePromise;
			resolve();
		}
		catch (e) {
			reject(e);
		}
	}.bind(this));
	
	// We don't handle select for PDF endpoint - just fail if multiple items
	translate.setHandler("select", (translate, items, callback) => {
		reject(new Error("Multiple items found - PDF endpoint does not support item selection"));
		callback([]);
	});
	
	translate.setCookieSandbox(this._cookieSandbox);
	translate.setRequestHeaders(headers);
	
	try {
		let req = await Zotero.HTTP.request(
			"GET",
			url,
			{
				responseType: 'document',
				cookieSandbox: this._cookieSandbox,
				headers
			}
		);
		translate.setDocument(req.response);
		translate.getTranslators(true);
		
		await promise;
	}
	catch (e) {
		Zotero.debug(e, 1);
		
		if (e instanceof Zotero.HTTP.StatusError && e.status == 404) {
			this.ctx.throw(400, "Remote page not found");
		}
		
		if (e instanceof Zotero.HTTP.ResponseSizeError) {
			this.ctx.throw(400, "Response exceeds max size");
		}
		
		if (e instanceof Zotero.HTTP.UnsupportedFormatError) {
			this.ctx.throw(400, "The remote document is not in a supported format");
		}
		
		// Check if error has a status code (from ctx.throw)
		if (e.status) {
			this.ctx.throw(e.status, e.message);
		}
		
		this.ctx.throw(500, "An error occurred retrieving the document");
	}
};

/**
 * Called when translators are available to perform translation and fetch PDF
 *
 * @return {Promise<undefined>}
 */
PDFSession.prototype.translate = async function (translate, translators) {
	// No matching translators
	if (!translators.length) {
		Zotero.debug("No translators found");
		this.ctx.throw(501, "No translators available for this URL\n");
		return;
	}
	
	var translator;
	var items;
	// eslint-disable-next-line no-await-in-loop
	while ((translator = translators.shift())) {
		translate.setTranslator(translator);
		try {
			// eslint-disable-next-line no-await-in-loop
			items = await translate.translate({
				libraryID: false
			});
			break;
		}
		catch (e) {
			Zotero.debug("Translation using " + translator.label + " failed", 1);
			Zotero.debug(e, 1);
			
			// If no more translators, fail
			if (!translators.length) {
				this.ctx.throw(500, "Translation failed\n");
				return;
			}
			
			// Try next translator
		}
	}
	
	// Find PDF attachment
	let pdfAttachment = null;
	let itemWithDOI = null;
	for (let item of items) {
		// Track item with DOI for Unpaywall fallback
		if (item.DOI && !itemWithDOI) {
			itemWithDOI = item;
		}
		
		if (item.attachments && item.attachments.length > 0) {
			// Look for primary attachment types (PDF, EPUB)
			for (let attachment of item.attachments) {
				if (PRIMARY_ATTACHMENT_TYPES.has(attachment.mimeType)) {
					pdfAttachment = attachment;
					break;
				}
			}
			if (pdfAttachment) break;
		}
	}
	
	// If no PDF found from translator, try Unpaywall
	if (!pdfAttachment && itemWithDOI) {
		pdfAttachment = await this.findPDFViaUnpaywall(itemWithDOI);
	}
	
	if (!pdfAttachment) {
		this.ctx.throw(501, "No PDF attachment found for this URL\n");
		return;
	}
	
	// Fetch the PDF
	try {
		let pdfURL = pdfAttachment.url;
		Zotero.debug(`Fetching PDF from ${pdfURL}`);
		
		// Use buffer responseType to get raw binary data
		let responseTypeMap = new Map([
			['application/pdf', 'buffer'],
			['application/octet-stream', 'buffer']
		]);
		
		let response = await Zotero.HTTP.request(
			"GET",
			pdfURL,
			{
				timeout: 60000,
				cookieSandbox: this._cookieSandbox,
				responseTypeMap: responseTypeMap,
				successCodes: false, // Allow any status code
				maxResponseSize: 50 * 1024 * 1024 // 50MB max for PDFs
			}
		);
		
		// Note: We accept any content-type since many servers serve PDFs with generic MIME types
		// The translator already verified this is a PDF attachment, so we trust that
		
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
		
		// response.response is a Buffer when responseType is 'buffer'
		this.ctx.response.body = response.response;
	}
	catch (e) {
		Zotero.debug("Error fetching PDF: " + e, 1);
		this.ctx.throw(500, "Failed to fetch PDF: " + e.message);
	}
};

/**
 * Try to find open-access PDF via Unpaywall
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
		
		// Look for best open access location
		let bestLocation = data.best_oa_location;
		if (!bestLocation || !bestLocation.url_for_pdf) {
			Zotero.debug("No PDF URL in Unpaywall response");
			return null;
		}
		
		Zotero.debug(`Found open-access PDF via Unpaywall: ${bestLocation.url_for_pdf}`);
		
		return {
			url: bestLocation.url_for_pdf,
			title: item.title || 'Unpaywall PDF',
			mimeType: 'application/pdf'
		};
	}
	catch (e) {
		Zotero.debug(`Unpaywall request failed: ${e.message}`, 1);
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
