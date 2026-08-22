interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: Uint8Array<ArrayBufferLike>): Promise<ArrayBuffer>;
}
