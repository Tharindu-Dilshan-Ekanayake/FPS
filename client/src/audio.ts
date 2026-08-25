// Web Audio API Procedural Sound Synthesizer (100% self-contained, no external audio files required)

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

// Crisp, punchy assault rifle gunshot sound
export function playGunshotSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // 1. Noise Burst (Gunshot Crack / High Frequency Blast)
    const bufferSize = ctx.sampleRate * 0.15;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(2800, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(300, now + 0.12);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(1.0, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);

    whiteNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    whiteNoise.start(now);
    whiteNoise.stop(now + 0.12);

    // 2. Sub-Bass Punch (Low End Body / Thump)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();

    subOsc.type = "triangle";
    subOsc.frequency.setValueAtTime(140, now);
    subOsc.frequency.exponentialRampToValueAtTime(35, now + 0.18);

    subGain.gain.setValueAtTime(0.9, now);
    subGain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);

    subOsc.connect(subGain);
    subGain.connect(ctx.destination);

    subOsc.start(now);
    subOsc.stop(now + 0.18);

    // 3. Mechanical crack transient (bolt/action snap for realism)
    const crackOsc = ctx.createOscillator();
    const crackGain = ctx.createGain();
    crackOsc.type = "square";
    crackOsc.frequency.setValueAtTime(3200, now);
    crackOsc.frequency.exponentialRampToValueAtTime(900, now + 0.02);
    crackGain.gain.setValueAtTime(0.35, now);
    crackGain.gain.exponentialRampToValueAtTime(0.01, now + 0.025);
    crackOsc.connect(crackGain);
    crackGain.connect(ctx.destination);
    crackOsc.start(now);
    crackOsc.stop(now + 0.025);

    // 4. Short slap-back tail (fake early reflection, adds body/space to the shot)
    const tailSize = Math.floor(ctx.sampleRate * 0.1);
    const tailBuffer = ctx.createBuffer(1, tailSize, ctx.sampleRate);
    const tailData = tailBuffer.getChannelData(0);
    for (let i = 0; i < tailSize; i++) {
      tailData[i] = (Math.random() * 2 - 1) * (1 - i / tailSize);
    }
    const tailNoise = ctx.createBufferSource();
    tailNoise.buffer = tailBuffer;
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = "bandpass";
    tailFilter.frequency.value = 900;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.16, now + 0.05);
    tailGain.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
    tailNoise.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(ctx.destination);
    tailNoise.start(now + 0.05);
    tailNoise.stop(now + 0.16);
  } catch {
    // AudioContext permission or browser policy
  }
}

// Empty Chamber Click
export function playEmptyClickSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.04);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.04);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Reload Mechanical Action Sound
export function playReloadSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Mag eject click
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(300, now);
    osc1.frequency.exponentialRampToValueAtTime(100, now + 0.1);
    gain1.gain.setValueAtTime(0.4, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.1);

    // Mag insert click (after 0.8s)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sawtooth";
    osc2.frequency.setValueAtTime(600, now + 0.8);
    osc2.frequency.exponentialRampToValueAtTime(250, now + 0.95);
    gain2.gain.setValueAtTime(0.5, now + 0.8);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.95);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.8);
    osc2.stop(now + 0.95);

    // Bolt rack slide (after 1.4s)
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = "square";
    osc3.frequency.setValueAtTime(450, now + 1.4);
    osc3.frequency.exponentialRampToValueAtTime(180, now + 1.55);
    gain3.gain.setValueAtTime(0.4, now + 1.4);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 1.55);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now + 1.4);
    osc3.stop(now + 1.55);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Hit Confirmation Sound
export function playHitSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.setValueAtTime(1600, now + 0.03);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.08);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Footstep — soft filtered thud, pitch-varied so a run doesn't sound robotic
export function playFootstepSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const bufferSize = Math.floor(ctx.sampleRate * 0.06);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(280 + Math.random() * 160, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.07);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + 0.07);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Jump — quick rising whoosh
export function playJumpSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.09);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Landing — low thud with a short noise slap
export function playLandSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const bufferSize = Math.floor(ctx.sampleRate * 0.09);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(260, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.1);

    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(90, now);
    oGain.gain.setValueAtTime(0.22, now);
    oGain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
    osc.connect(oGain);
    oGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Ambient environment bed — soft filtered wind, loops quietly for atmosphere
let ambientNodes: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

export function startAmbientAmbience() {
  try {
    if (ambientNodes) return;
    const ctx = getAudioContext();

    const bufferSize = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[i] = lastOut * 3.2;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 340;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    const now = ctx.currentTime;
    gain.gain.linearRampToValueAtTime(0.045, now + 2);

    ambientNodes = { source, gain };
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

export function stopAmbientAmbience() {
  if (!ambientNodes) return;
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    ambientNodes.gain.gain.linearRampToValueAtTime(0, now + 0.4);
    ambientNodes.source.stop(now + 0.5);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
  ambientNodes = null;
}

// Enemy gunshot — same family as the player's rifle but pitched down and
// distanced, so a shot from the bot reads as distinct from your own weapon.
export function playEnemyGunshotSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const bufferSize = ctx.sampleRate * 0.15;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(1800, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(220, now + 0.14);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.55, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);

    whiteNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    whiteNoise.start(now);
    whiteNoise.stop(now + 0.14);

    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = "triangle";
    subOsc.frequency.setValueAtTime(100, now);
    subOsc.frequency.exponentialRampToValueAtTime(28, now + 0.2);
    subGain.gain.setValueAtTime(0.5, now);
    subGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    subOsc.connect(subGain);
    subGain.connect(ctx.destination);
    subOsc.start(now);
    subOsc.stop(now + 0.2);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}

// Player takes damage — low pained thud, distinct from the hit-confirm chime
export function playPlayerHurtSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const bufferSize = Math.floor(ctx.sampleRate * 0.12);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(500, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.14);

    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.18);
    oGain.gain.setValueAtTime(0.3, now);
    oGain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
    osc.connect(oGain);
    oGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch {
    // Web Audio unavailable or blocked by browser policy
  }
}
