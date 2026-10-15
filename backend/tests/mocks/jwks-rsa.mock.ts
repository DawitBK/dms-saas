export default function jwksClient() {
  return {
    getSigningKey: async () => ({
      getPublicKey: () => "",
    }),
  };
}
