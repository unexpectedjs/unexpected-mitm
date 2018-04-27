module.exports = function trimHeadersLower(message) {
    delete message.headers.valuesByName['content-length'];
    delete message.headers.valuesByName['transfer-encoding'];
    delete message.headers.valuesByName.connection;
    delete message.headers.valuesByName.date;

    return message;
};
