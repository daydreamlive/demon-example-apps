import * as Tone from 'https://esm.sh/tone';

// Minimal Tone bootstrap.
//
// The Tone.js synthesizer was removed from this demo: DEMON renders all
// audio now, and the hand gestures are purely a CONTROL SURFACE that drives
// model knobs (see demon-bridge.js). All that remains here is starting the
// audio context + master Transport so the on-screen beat metronome animates.
export var MusicManager = /*#__PURE__*/ (function () {
    'use strict';
    function MusicManager() {
        this.isStarted = false;
    }
    // Must be called from a user gesture (Tone.start needs one).
    MusicManager.prototype.start = function start() {
        var _this = this;
        return (async function () {
            if (_this.isStarted) return;
            await Tone.start();
            Tone.Transport.bpm.value = 100;
            Tone.Transport.start();
            _this.isStarted = true;
            console.log('Tone.js AudioContext + Transport started (synth removed).');
        })();
    };
    return MusicManager;
})();
