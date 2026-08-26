# @varlock/aws-sigv4-plugin

Adds an `aws-sigv4` request-signing scheme to the [varlock credential proxy](https://varlock.dev/guides/proxy/).

The agent's AWS SDK signs requests normally, using the placeholder credentials varlock injects into its environment. The proxy parses the region and service out of the inbound credential scope, strips the placeholder signature, and re-signs the request with the real keys at the network boundary. The secret access key never enters the agent's environment, and the agent cannot produce a valid signature itself.

```env-spec
# @plugin(@varlock/aws-sigv4-plugin)
# ---
# @proxy(domain="*.amazonaws.com", transform={
#   scheme="aws-sigv4", keyId="AWS_ACCESS_KEY_ID",
#   allowedServices=[bedrock, s3],
# })
AWS_SECRET_ACCESS_KEY=somePlugin()

# @sensitive
AWS_ACCESS_KEY_ID=somePlugin()
```

See the [request signing docs](https://varlock.dev/guides/proxy/rules/#request-signing) for all options.
