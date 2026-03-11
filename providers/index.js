const db = require('../db');
const rumbleupProvider = require('./rumbleup');

const providers = {
  rumbleup: rumbleupProvider
};

/**
 * Get the currently selected messaging provider name from settings.
 * Defaults to 'rumbleup'.
 */
function getActiveProviderName() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sms_provider'").get();
  return (row && row.value && providers[row.value]) ? row.value : 'rumbleup';
}

/**
 * Set the active messaging provider.
 */
function setActiveProvider(name) {
  if (!providers[name]) throw new Error('Unknown provider: ' + name);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run('sms_provider', name, name);
}

/**
 * Get the active provider module.
 */
function getProvider() {
  const name = getActiveProviderName();
  const provider = providers[name];
  if (!provider) throw new Error('Unknown provider: ' + name);
  return provider;
}

/**
 * Get a specific provider by name (for settings UI).
 */
function getProviderByName(name) {
  return providers[name] || null;
}

/**
 * List all available providers (for settings UI dropdown).
 */
function listProviders() {
  return Object.values(providers).map(p => ({ name: p.name, label: p.label }));
}

module.exports = {
  getProvider,
  getProviderByName,
  getActiveProviderName,
  setActiveProvider,
  listProviders
};
