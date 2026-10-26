// Le poche funzioni di crypto usate dal tavolo, con il generatore casuale del browser
function randomBytes(n) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
  return { toString: () => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

// randomInt(max) oppure randomInt(min, max), con max escluso
function randomInt(min, max) {
  if (max === undefined) [min, max] = [0, min];
  const range = max - min;
  const limit = Math.floor(2 ** 32 / range) * range; // scarta i valori che renderebbero la scelta sbilanciata
  const buf = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(buf); while (buf[0] >= limit);
  return min + (buf[0] % range);
}

module.exports = { randomBytes, randomInt };
