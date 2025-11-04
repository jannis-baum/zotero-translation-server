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
	
	// Download and return the PDF
	await this.downloadPDF(pdfAttachment);
};

/**
 * Download a PDF from an attachment object and return it
 * @param {Object} pdfAttachment - Attachment object with url, title, mimeType
 * @return {Promise<undefined>}
 */
PDFSession.prototype.downloadPDF = async function (pdfAttachment) {
	try {
		let pdfURL = pdfAttachment.url;
		Zotero.debug(`Fetching PDF from ${pdfURL}`);
		
		// Use buffer responseType to get raw binary data
		let responseTypeMap = new Map([
			['application/pdf', 'buffer'],
			['application/octet-stream', 'buffer'],
			['text/html', 'buffer'] // Some servers return HTML for PDFs
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
		
		// Check if we actually got a PDF (starts with %PDF)
		let buffer = response.response;
		if (Buffer.isBuffer(buffer)) {
			let header = buffer.slice(0, 5).toString('utf8');
			if (!header.startsWith('%PDF')) {
				// Not a PDF - probably an error page
				let contentType = response.getResponseHeader('content-type');
				Zotero.debug(`Expected PDF but got content-type: ${contentType}`);
				Zotero.debug(`Response starts with: ${buffer.slice(0, 200).toString('utf8')}`);
				throw new Error(`Downloaded file is not a PDF (starts with: ${header})`);
			}
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
