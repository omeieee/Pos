import { describe, expect, test } from 'vitest';
import { canonicalQuery, sha256Hex, signRequest } from './sigv4.ts';

describe('signRequest', () => {
  // The worked example "GET Object" in AWS's Signature Version 4 documentation for S3.
  test('matches the published AWS test vector', () => {
    const headers = signRequest({
      method: 'GET',
      path: '/test.txt',
      query: '',
      host: 'examplebucket.s3.amazonaws.com',
      headers: { Range: 'bytes=0-9' },
      payloadHash: sha256Hex(''),
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  test('the query is sorted and strictly encoded', () => {
    expect(canonicalQuery({ prefix: 'slips/', 'list-type': '2', t: "a+b/c=d'" })).toBe(
      'list-type=2&prefix=slips%2F&t=a%2Bb%2Fc%3Dd%27',
    );
  });
});
