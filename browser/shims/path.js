// Solo quello che serve a decks.js e scryfall.js
const join = (...parts) => ('/' + parts.join('/')).replace(/\/+/g, '/');
const dirname = (p) => p.replace(/\/[^/]*$/, '') || '/';

module.exports = { join, dirname };
