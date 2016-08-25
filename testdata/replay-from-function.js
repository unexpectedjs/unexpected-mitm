module.exports = function (expect) {
    return {
        "request": {
            "body": expect.it('to end with', '123')
        },
        "response": {
            "statusCode": 405,
            "headers": {
                "Allow": "GET, HEAD"
            }
        }
    };
};
