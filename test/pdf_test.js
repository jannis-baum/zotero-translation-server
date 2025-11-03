/* global assert:false, request:false, testURL:false */

describe("/pdf", function () {
	it("should return 501 for a generic webpage with no PDF", async function () {
		var url = testURL + 'plain';
		var response = await request()
			.post('/pdf')
			.set('Content-Type', 'text/plain')
			.send(url);
		assert.equal(response.statusCode, 501);
	});
	
	it("should return 400 for invalid URL", async function () {
		var response = await request()
			.post('/pdf')
			.set('Content-Type', 'text/plain')
			.send('not a url');
		assert.equal(response.statusCode, 400);
	});
});
