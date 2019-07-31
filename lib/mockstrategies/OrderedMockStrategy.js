module.exports = class OrderedMockStrategy {
  constructor(requestDescriptions) {
    this.requestDescriptions = requestDescriptions;
    this.nextRequestDescriptionIndex = 0;
  }

  get isEmpty() {
    return this.nextRequestDescriptionIndex >= this.requestDescriptions.length;
  }

  firstDescriptionRemaining() {
    return this.nextDescriptionForIncomingRequest();
  }

  nextDescriptionForIncomingRequest() {
    if (this.isEmpty) {
      return Promise.resolve(null);
    }

    const description = this.requestDescriptions[
      this.nextRequestDescriptionIndex
    ];
    this.nextRequestDescriptionIndex += 1;
    return Promise.resolve(description);
  }
};
