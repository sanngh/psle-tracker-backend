const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const baseEnvFile = path.resolve(__dirname, '.env');
if (fs.existsSync(baseEnvFile)) dotenv.config({ path: baseEnvFile });

const runtimeEnv = (process.env.ENV || process.env.NODE_ENV || 'dev').toLowerCase();
const runtimeEnvFile = path.resolve(__dirname, `.env.${runtimeEnv}`);
if (fs.existsSync(runtimeEnvFile)) dotenv.config({ path: runtimeEnvFile, override: true });

const asBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const asInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOrigins = (value) => {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
};

const parseRevisionLevels = (value) => {
  const levels = String(value || '')
    .split(',')
    .map(level => level.trim().toUpperCase())
    .filter(level => ['P4', 'P5', 'P6'].includes(level));
  return levels.length > 0 ? [...new Set(levels)] : ['P4', 'P5', 'P6'];
};

const parseConfidenceLevels = (value) => {
  const levels = String(value || '')
    .split(',')
    .map(level => level.trim())
    .filter(level => ['Low', 'Medium', 'Good', 'Very Good', 'High'].includes(level));
  return levels.length > 0 ? [...new Set(levels)] : ['Low', 'Medium', 'Good', 'Very Good', 'High'];
};

const normalizeProvider = (value, allowedProviders, fallback) => {
  const provider = String(value || fallback).trim().toLowerCase();
  return allowedProviders.includes(provider) ? provider : fallback;
};

const missingValues = (values) => Object.entries(values)
  .filter(([, value]) => !String(value || '').trim())
  .map(([name]) => name);

const validateCloudProviders = (candidate) => {
  const errors = [];
  if (candidate.databaseProvider === 'turso') {
    const missing = missingValues({ TURSO_DATABASE_URL: candidate.tursoDatabaseUrl, TURSO_AUTH_TOKEN: candidate.tursoAuthToken });
    if (missing.length > 0) errors.push(`Turso is selected but these settings are missing: ${missing.join(', ')}`);
  }
  if (candidate.mediaStorageProvider === 'r2') {
    const missing = missingValues({
      R2_ACCOUNT_ID: candidate.r2AccountId,
      R2_ACCESS_KEY_ID: candidate.r2AccessKeyId,
      R2_SECRET_ACCESS_KEY: candidate.r2SecretAccessKey,
      R2_BUCKET: candidate.r2Bucket,
      R2_PUBLIC_BASE_URL: candidate.r2PublicBaseUrl
    });
    if (missing.length > 0) errors.push(`R2 is selected but these settings are missing: ${missing.join(', ')}`);
  }
  return errors;
};

const parseByteSize = (value, fallbackBytes = 100 * 1024 * 1024) => {
  if (value === undefined || value === null || value === '') return fallbackBytes;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/^([\d.]+)\s*(bytes?|kb|mb|gb|tb)?$/i);
  if (!match) return fallbackBytes;

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] || 'bytes').toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024
  };

  const multiplier = multipliers[unit] ?? 1;
  return Math.max(0, Math.round(amount * multiplier));
};

const useSqlite = asBoolean(process.env.USE_SQLITE, runtimeEnv !== 'prod');
const databaseProvider = normalizeProvider(
  process.env.DATABASE_PROVIDER,
  ['sqlite', 'turso'],
  useSqlite ? 'sqlite' : 'turso'
);

const config = {
  appName: process.env.APP_NAME || 'PSLE Tracker',
  nodeEnv: runtimeEnv,
  env: runtimeEnv,
  port: asInteger(process.env.PORT, 3000),
  // Number of reverse proxy hops in front of this app (e.g. 1 for Cloud Run's load balancer).
  // Never use `true`, which trusts a client-supplied X-Forwarded-For header unconditionally
  // and lets attackers spoof their IP to bypass rate limiting.
  trustProxy: asBoolean(process.env.TRUST_PROXY, false) ? asInteger(process.env.TRUST_PROXY_HOPS, 1) : false,
  requireEvidenceLinking: asBoolean(process.env.REQUIRE_EVIDENCE_LINKING, true),
  databaseProvider,
  useSqlite: databaseProvider === 'sqlite',
  dbPath: process.env.DB_PATH || path.join(__dirname, 'psle_tracker.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'),
  mediaStorageProvider: normalizeProvider(process.env.MEDIA_STORAGE_PROVIDER, ['local', 'r2'], 'local'),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  rateLimitWindowMs: asInteger(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  rateLimitMaxRequests: asInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 120),
  authRateLimitWindowMs: asInteger(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
  authRateLimitMaxRequests: asInteger(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
  maxJsonPayloadBytes: process.env.MAX_JSON_PAYLOAD_BYTES || '1mb',
  maxUploadBytes: parseByteSize(process.env.MAX_UPLOAD_BYTES, 15 * 1024 * 1024),
  uploadRateLimitWindowMs: asInteger(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
  uploadRateLimitMaxRequests: asInteger(process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS, 20),
  maxUploadsPerUserPerDay: asInteger(process.env.MAX_UPLOADS_PER_USER_PER_DAY, 50),
  revisionLevels: parseRevisionLevels(process.env.REVISION_LEVELS),
  confidenceLevels: parseConfidenceLevels(process.env.CONFIDENCE_LEVELS),
  keywordTagLimit: asInteger(process.env.KEYWORD_TAG_LIMIT, 3),
  tursoDatabaseUrl: process.env.TURSO_DATABASE_URL || '',
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN || '',
  r2AccountId: process.env.R2_ACCOUNT_ID || '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  r2Bucket: process.env.R2_BUCKET || '',
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'change-this-secret-in-production',
  adminToken: process.env.ADMIN_TOKEN || ''
};

config.parseByteSize = parseByteSize;
config.validateCloudProviders = () => validateCloudProviders(config);
config.validateCloudProviderSettings = validateCloudProviders;

module.exports = config;