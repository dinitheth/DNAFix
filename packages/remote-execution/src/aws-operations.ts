import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand, StopBuildCommand } from "@aws-sdk/client-codebuild";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Operation ports over AWS SDK for JavaScript v3.
 * Production implementations wrap the real SDK clients; tests inject fakes at
 * this boundary (mocked AWS clients, no network). Credentials resolve through
 * the SDK default provider chain (environment, shared config/ini profile,
 * IAM roles) — DNAFix never handles raw AWS keys.
 */

export interface BuildInfo {
  id: string;
  status: string;
  logGroupName: string | null;
  logStreamName: string | null;
  logsDeepLink: string | null;
  artifactsLocation: string | null;
}

export interface CodeBuildOperations {
  startBuild(input: {
    projectName: string;
    sourceLocation: string;
    buildspec: string;
    artifactsLocation: string;
    artifactsPath: string;
    timeoutInMinutes: number;
    idempotencyToken: string;
  }): Promise<{ buildId: string }>;
  batchGetBuilds(ids: string[]): Promise<BuildInfo[]>;
  stopBuild(id: string): Promise<void>;
}

export interface S3Operations {
  putObject(input: { bucket: string; key: string; body: Buffer | string; contentType: string; metadata?: Record<string, string> }): Promise<void>;
  getObjectText(input: { bucket: string; key: string }): Promise<string>;
}

export interface LogsOperations {
  /** Returns concatenated log messages (bounded), following pagination up to maxPages. */
  getLogText(input: { logGroupName: string; logStreamName: string; maxEvents: number }): Promise<string>;
}

export class SdkCodeBuildOperations implements CodeBuildOperations {
  constructor(private readonly client: CodeBuildClient) {}
  async startBuild(input: {
    projectName: string;
    sourceLocation: string;
    buildspec: string;
    artifactsLocation: string;
    artifactsPath: string;
    timeoutInMinutes: number;
    idempotencyToken: string;
  }): Promise<{ buildId: string }> {
    const out = await this.client.send(
      new StartBuildCommand({
        projectName: input.projectName,
        sourceTypeOverride: "S3",
        sourceLocationOverride: input.sourceLocation,
        buildspecOverride: input.buildspec,
        artifactsOverride: { type: "S3", location: input.artifactsLocation, path: input.artifactsPath, packaging: "ZIP" },
        timeoutInMinutesOverride: input.timeoutInMinutes,
        computeTypeOverride: "BUILD_GENERAL1_SMALL",
        idempotencyToken: input.idempotencyToken,
        // privilegedMode is never overridden: the project's disabled setting stands.
      }),
    );
    if (!out.build?.id) throw new Error("CodeBuild StartBuild returned no build id");
    return { buildId: out.build.id };
  }
  async batchGetBuilds(ids: string[]): Promise<BuildInfo[]> {
    const out = await this.client.send(new BatchGetBuildsCommand({ ids }));
    return (out.builds ?? []).map((b) => ({
      id: b.id ?? "",
      status: b.buildStatus ?? "",
      logGroupName: b.logs?.groupName ?? null,
      logStreamName: b.logs?.streamName ?? null,
      logsDeepLink: b.logs?.deepLink ?? null,
      artifactsLocation: b.artifacts?.location ?? null,
    }));
  }
  async stopBuild(id: string): Promise<void> {
    await this.client.send(new StopBuildCommand({ id }));
  }
}

export class SdkS3Operations implements S3Operations {
  constructor(private readonly client: S3Client) {}
  async putObject(input: { bucket: string; key: string; body: Buffer | string; contentType: string; metadata?: Record<string, string> }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ServerSideEncryption: "AES256",
        Metadata: input.metadata,
      }),
    );
  }
  async getObjectText(input: { bucket: string; key: string }): Promise<string> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
    return (await out.Body?.transformToString()) ?? "";
  }
}

export class SdkLogsOperations implements LogsOperations {
  constructor(private readonly client: CloudWatchLogsClient) {}
  async getLogText(input: { logGroupName: string; logStreamName: string; maxEvents: number }): Promise<string> {
    const messages: string[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 10 && messages.length < input.maxEvents; page++) {
      const out = await this.client.send(
        new GetLogEventsCommand({
          logGroupName: input.logGroupName,
          logStreamName: input.logStreamName,
          limit: Math.min(1000, input.maxEvents - messages.length),
          nextToken,
          startFromHead: true,
        }),
      );
      for (const event of out.events ?? []) messages.push(event.message ?? "");
      if (!out.nextForwardToken || out.nextForwardToken === nextToken) break;
      nextToken = out.nextForwardToken;
    }
    return messages.join("\n");
  }
}

export interface AwsClients {
  codebuild: CodeBuildOperations;
  s3: S3Operations;
  logs: LogsOperations;
}

export function createAwsClients(region: string): AwsClients {
  return {
    codebuild: new SdkCodeBuildOperations(new CodeBuildClient({ region })),
    s3: new SdkS3Operations(new S3Client({ region })),
    logs: new SdkLogsOperations(new CloudWatchLogsClient({ region })),
  };
}
