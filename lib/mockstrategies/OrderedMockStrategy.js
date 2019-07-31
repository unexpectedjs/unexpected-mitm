module.exports = class OrderedMockStrategy {
  constructor(requestDescriptions) {
    this.requestDescriptions = requestDescriptions;
    this.nextRequestDescriptionIndex = 0;
  }

  firstDescriptionRemaining() {
    return this.nextDescriptionForIncomingRequest();
  }

  hasDescriptionsRemaining() {
    return this.nextRequestDescriptionIndex < this.requestDescriptions.length;
  }

  nextDescriptionForIncomingRequest() {
    if (!this.hasDescriptionsRemaining()) {
      return Promise.resolve(null);
    }

    const description = this.requestDescriptions[
      this.nextRequestDescriptionIndex
    ];
    this.nextRequestDescriptionIndex += 1;
    return Promise.resolve(description);
  }
};
