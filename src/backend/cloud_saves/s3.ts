import { createReadStream, createWriteStream } from 'graceful-fs'
import { stat } from 'fs/promises'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'

import type { CloudStorageConfig } from 'common/types'
import type {
  CloudStorageProvider,
  RemoteObjectDetails,
  RemoteObjectSummary
} from './types'

/**
 * S3-compatible object storage provider.
 * Works with AWS S3 as well as any service speaking the S3 API (MinIO,
 * Backblaze B2, Cloudflare R2, Wasabi, DigitalOcean Spaces, ...)
 */
export class S3Provider implements CloudStorageProvider {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(config: CloudStorageConfig) {
    this.bucket = config.bucket.trim()
    this.client = new S3Client({
      // AWS requires a region; most other providers ignore it but the SDK
      // still needs *something* to build the signature
      region: config.region.trim() || 'us-east-1',
      endpoint: config.endpoint.trim() || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId.trim(),
        secretAccessKey: config.secretAccessKey
      },
      // Newer SDK versions send CRC checksums by default, which many
      // S3-compatible services don't understand
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  }

  async listObjects(prefix: string): Promise<RemoteObjectSummary[]> {
    const objects: RemoteObjectSummary[] = []
    let continuationToken: string | undefined

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      )
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue
        objects.push({
          key: object.Key,
          size: object.Size ?? 0,
          etag: object.ETag,
          lastModifiedMs: object.LastModified?.getTime()
        })
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined
    } while (continuationToken)

    return objects
  }

  async headObject(key: string): Promise<RemoteObjectDetails | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      )
      return {
        key,
        size: response.ContentLength ?? 0,
        etag: response.ETag,
        lastModifiedMs: response.LastModified?.getTime(),
        metadata: response.Metadata ?? {}
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async getObject(key: string, destPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    )
    if (!response.Body) {
      throw new Error(`Empty response body for ${key}`)
    }
    await pipeline(response.Body as Readable, createWriteStream(destPath))
  }

  async putObject(
    key: string,
    srcPath: string,
    metadata: Record<string, string>
  ): Promise<void> {
    const { size } = await stat(srcPath)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(srcPath),
        ContentLength: size,
        Metadata: metadata
      })
    )
  }

  async testConnection(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    // HeadBucket only proves the bucket exists; make sure we can list too
    await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 })
    )
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, $metadata } = error as {
    name?: string
    $metadata?: { httpStatusCode?: number }
  }
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    $metadata?.httpStatusCode === 404
  )
}
