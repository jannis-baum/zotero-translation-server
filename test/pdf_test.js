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
});
