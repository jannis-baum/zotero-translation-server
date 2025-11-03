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

const PDFSession = require('./pdfSession');

var PDFEndpoint = module.exports = {
	handle: async function (ctx, next) {
		ctx.assert(ctx.is('text/plain') || ctx.is('json'), 415);
		
		var data = ctx.request.body;
		
		if (!data) {
			ctx.throw(400, "POST data not provided\n");
		}
		
		// From https://stackoverflow.com/a/3809435, modified to allow up to 9-char TLDs and IP addresses
		let urlRE = /^(https?:\/\/)?([-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,9}\b|((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.|\b)){4})(\S*)$/i;
		
		if (!data.match(urlRE)) {
			ctx.throw(400, "URL not provided");
		}
		
		// Prepend 'http://' if not provided
		if (!data.startsWith('http')) {
			data = 'http://' + data;
		}
		
		let session = new PDFSession(ctx, next, data);
		await session.handleURL();
	}
};
