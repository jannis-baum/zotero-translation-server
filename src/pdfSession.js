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
	
	// Collect all potential PDF attachments
	let pdfCandidates = [];
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
					pdfCandidates.push(attachment);
				}
			}
		}
	}
	
	// If no PDF found from items, get candidates from Unpaywall
	if (pdfCandidates.length === 0 && itemWithDOI) {
		let unpaywallCandidates = await this.findPDFCandidatesViaUnpaywall(itemWithDOI);
		pdfCandidates.push(...unpaywallCandidates);
	}
	
	if (pdfCandidates.length === 0) {
		this.ctx.throw(501, "No PDF attachment found in provided items\n");
		return;
	}
	
	// Try downloading each candidate until one succeeds
	let lastError = null;
	for (let candidate of pdfCandidates) {
		try {
			Zotero.debug(`Trying to download PDF from: ${candidate.url}`);
			try {
				await this.downloadPDF(candidate);
			}
			catch (e) {
				await this.downloadPDFWithPlaywright(candidate);
			}
			return; // Success! Exit the function
		}
		catch (e) {
			Zotero.debug(`Failed to download PDF from ${candidate.url}: ${e.message}`);
			lastError = e;
			// Continue to next candidate
		}
	}
	
	// If we get here, all candidates failed
	this.ctx.throw(500, `Failed to download PDF from any of ${pdfCandidates.length} candidates. Last error: ${lastError ? lastError.message : 'Unknown'}`);
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
		
		// Navigate and wait for download with timeout
		const [download] = await Promise.all([
			page.waitForEvent('download', { timeout: 7000 }),
			page.goto(pdfURL, { timeout: 7000 })
		]);
		
		// Get the downloaded file as a buffer
		const stream = await download.createReadStream();
		const chunks = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
		}
		const buffer = Buffer.concat(chunks);
		this.validatePDF(buffer, pdfAttachment.title);
	}
	catch (e) {
		Zotero.debug("Error fetching PDF with Playwright: " + e, 1);
		// Don't throw here, let the caller handle it
		throw e;
	}
	finally {
		if (browser) {
			await browser.close();
		}
	}
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
		this.validatePDF(buffer, pdfAttachment.title);
	}
	catch (e) {
		Zotero.debug("Error fetching PDF: " + e, 1);
		throw e;
	}
};

PDFSession.prototype.validatePDF = function (buffer, title) {
	// Verify it's a PDF
	if (!Buffer.isBuffer(buffer)) throw new Error('No buffer was returned');
	const header = buffer.slice(0, 5).toString('utf8');
	if (!header.startsWith('%PDF')) {
		throw new Error(`Downloaded file is not a PDF (starts with: ${header})`);
	}
		
	// Return the PDF
	this.ctx.response.status = 200;
	this.ctx.response.set('Content-Type', 'application/pdf');
	if (title) {
		// Sanitize filename: remove path components, special chars, and limit length
		let filename = title
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
};


/**
 * Find all possible PDF candidates via Unpaywall by trying all OA locations
 * @param {Object} item - Item with DOI
 * @return {Promise<Array>} - Array of PDF attachment objects
 */
PDFSession.prototype.findPDFCandidatesViaUnpaywall = async function (item) {
	if (!item.DOI) return [];
	
	let doi = Zotero.Utilities.cleanDOI(item.DOI);
	if (!doi) return [];
	
	Zotero.debug(`Trying Unpaywall for DOI: ${doi}`);
	
	// Get email for Unpaywall API
	let email = await this.getUnpaywallEmail();
	if (!email) {
		Zotero.debug("No email configured for Unpaywall API");
		return [];
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
			return [];
		}
		
		let data = response.response;
		
		// Try all OA locations, not just the best one
		let oaLocations = data.oa_locations || [];
		if (oaLocations.length === 0) {
			Zotero.debug("No OA locations in Unpaywall response");
			return [];
		}
		
		Zotero.debug(`Found ${oaLocations.length} OA locations from Unpaywall`);
		
		let pdfCandidates = [];
		
		// Try each OA location
		for (let location of oaLocations) {
			Zotero.debug(`Processing OA location: ${location.url_for_landing_page || location.url}`);
			
			// If there's a direct PDF URL, add it as a candidate
			if (location.url_for_pdf) {
				Zotero.debug(`Found direct PDF URL: ${location.url_for_pdf}`);
				pdfCandidates.push({
					url: location.url_for_pdf,
					title: item.title || 'Unpaywall PDF',
					mimeType: 'application/pdf'
				});
			}
			
			// Also try the landing page with /web endpoint to get attachments
			let landingPage = location.url_for_landing_page || location.url;
			if (landingPage) {
				try {
					Zotero.debug(`Trying landing page via translator: ${landingPage}`);
					let webItems = await this.getItemsFromURL(landingPage);
					
					// Check if we got items with PDF attachments
					if (webItems && webItems.length > 0) {
						for (let webItem of webItems) {
							if (webItem.attachments && webItem.attachments.length > 0) {
								for (let attachment of webItem.attachments) {
									if (PRIMARY_ATTACHMENT_TYPES.has(attachment.mimeType)) {
										Zotero.debug(`Found PDF attachment via translator: ${attachment.url}`);
										pdfCandidates.push(attachment);
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
		
		Zotero.debug(`Found ${pdfCandidates.length} PDF candidates from Unpaywall`);
		return pdfCandidates;
	}
	catch (e) {
		Zotero.debug(`Unpaywall request failed: ${e.message}`, 1);
		return [];
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
