// Runs Kokoro once, in a process of its own (ADR 0017): the native addon and
// the model load here, so neither sits in the studio server, and a crash takes
// only this. Reads one JSON job on stdin and writes a WAV. Plain CommonJS, since
// the app copies this file beside its bundles and the addon is required by path.

const { join } = require('node:path');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const { runtime, model, lang, lexicon, sid, text, out } = JSON.parse(input);
  const sherpa = require(join(runtime, 'sherpa-onnx-node/sherpa-onnx.js'));
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: join(model, 'model.onnx'),
        voices: join(model, 'voices.bin'),
        tokens: join(model, 'tokens.txt'),
        dataDir: join(model, 'espeak-ng-data'),
        ...(lexicon ? { lexicon: join(model, lexicon) } : {}),
        lang,
      },
      debug: false,
      numThreads: 2,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
  // Electron's V8 refuses buffers that live outside its heap.
  const audio = tts.generate({ text, sid, speed: 1, enableExternalBuffer: false });
  sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
});
