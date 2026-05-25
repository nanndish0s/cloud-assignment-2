const Sequencer = require('@jest/test-sequencer').default;

class AlphaSequencer extends Sequencer {
  sort(tests) {
    return tests.sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = AlphaSequencer;
