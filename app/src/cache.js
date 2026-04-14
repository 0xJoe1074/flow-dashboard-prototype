'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../data/cache.json');

let _mem = null; // in-memory cache: { data, cachedAt }

function getCache() {
  if (_mem && !_isExpired(_mem)) return _mem.data;

  // Fallback to file cache
  const fromFile = _readFile();
  if (fromFile && !_isExpired(fromFile)) {
    _mem = fromFile;
    return fromFile.data;
  }
  return null;
}

function setCache(data) {
  const entry = { data, cachedAt: new Date().toISOString() };
  _mem = entry; // memory is the source of truth — disk write is best-effort
  const dir = path.dirname(CACHE_PATH);
  (async () => {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf-8');
    } catch (e) {
      console.warn('Cache-Datei konnte nicht geschrieben werden:', e.message);
    }
  })();
}

function clearCache() {
  _mem = null;
  try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
}

function getCacheStatus() {
  const entry = _mem || _readFile();
  if (!entry) return { cached: false };
  return {
    cached: true,
    cachedAt: entry.cachedAt,
    expired: _isExpired(entry)
  };
}

function _isExpired(entry) {
  const { readConfig } = require('./config');
  const ttlMs = (readConfig().dashboard?.refreshIntervalMinutes || 15) * 60 * 1000;
  return (Date.now() - new Date(entry.cachedAt).getTime()) > ttlMs;
}

function _readFile() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = { getCache, setCache, clearCache, getCacheStatus };
