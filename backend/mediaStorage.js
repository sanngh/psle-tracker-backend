const fs = require('fs');
const path = require('path');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const encodeObjectKey = (objectKey) => objectKey
  .split('/')
  .map(segment => encodeURIComponent(segment))
  .join('/');

const createLocalStorage = (config) => ({
  provider: 'local',
  async putObject({ objectKey, buffer }) {
    const absolutePath = path.join(config.uploadsDir, ...objectKey.split('/'));
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, buffer);
    return { objectKey };
  },
  getPublicUrl(objectKey, requestBaseUrl) {
    return `${trimTrailingSlash(requestBaseUrl)}/uploads/${encodeObjectKey(objectKey)}`;
  }
});

const createR2Storage = (config) => {
  const endpoint = config.r2Endpoint || `https://${config.r2AccountId}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey
    }
  });

  return {
    provider: 'r2',
    async putObject({ objectKey, buffer, contentType }) {
      await client.send(new PutObjectCommand({
        Bucket: config.r2Bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream'
      }));
      return { objectKey };
    },
    getPublicUrl(objectKey) {
      return `${trimTrailingSlash(config.r2PublicBaseUrl)}/${encodeObjectKey(objectKey)}`;
    }
  };
};

const createMediaStorage = (config) => config.mediaStorageProvider === 'r2'
  ? createR2Storage(config)
  : createLocalStorage(config);

module.exports = { createMediaStorage };