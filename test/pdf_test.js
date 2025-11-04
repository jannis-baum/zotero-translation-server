/* global assert:false, request:false, testURL:false */

describe("/pdf", function () {
	it("should return 501 when items have no PDF attachments", async function () {
		// First get items from /web
		var url = testURL + 'plain';
		var webResponse = await request()
			.post('/web')
			.set('Content-Type', 'text/plain')
			.send(url);
		assert.equal(webResponse.statusCode, 200);
		
		// Then try to get PDF from those items
		var pdfResponse = await request()
			.post('/pdf')
			.set('Content-Type', 'application/json')
			.send(webResponse.body);
		assert.equal(pdfResponse.statusCode, 501);
	});
	
	it("should return 400 for invalid input", async function () {
		var response = await request()
			.post('/pdf')
			.set('Content-Type', 'application/json')
			.send('not an array');
		assert.equal(response.statusCode, 400);
	});
	
	it("should return 400 for empty array", async function () {
		var response = await request()
			.post('/pdf')
			.set('Content-Type', 'application/json')
			.send([]);
		assert.equal(response.statusCode, 400);
	});
	
	// Real-world tests (require network access - skip in CI)
	describe("Real paper downloads", function () {
		this.timeout(30000); // Allow 30 seconds for network requests

		const testURL = async (url) => {
			var webResponse = await request()
				.post('/web')
				.set('Content-Type', 'text/plain')
				.send(url);
			assert.equal(webResponse.statusCode, 200);
			assert.isArray(webResponse.body);
			assert.isAbove(webResponse.body.length, 0);
			
			var pdfResponse = await request()
				.post('/pdf')
				.set('Content-Type', 'application/json')
				.send(webResponse.body);
			assert.equal(pdfResponse.statusCode, 200);
			assert.equal(pdfResponse.headers['content-type'], 'application/pdf');
			
			// Verify it's actually a PDF (starts with %PDF)
			var pdfBuffer = Buffer.from(pdfResponse.body);
			var header = pdfBuffer.slice(0, 5).toString('utf8');
			assert.equal(header, '%PDF-', 'Downloaded file should be a valid PDF');
			assert.isAbove(pdfBuffer.length, 1000, 'PDF should be substantial size');
		};
		
		it("should download PDF from arXiv using translator attachments", async function () {
			await testURL('https://arxiv.org/abs/2505.23839v1');
		});

		it("should download PDF from Science.org using Unpaywall", async function () {
			await testURL('https://www.science.org/doi/10.1126/science.aar4120');
		});

		it("should download PDF from ASM Journals using Playwright to fully load the site", async function () {
			await testURL('https://journals.asm.org/doi/10.1128/mmbr.00022-25');
		});
	});
});
