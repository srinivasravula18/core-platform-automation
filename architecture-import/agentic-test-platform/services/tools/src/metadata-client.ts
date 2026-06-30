import type { MetadataApp, MetadataObject, ObjectDescriptor } from "@atp/shared";

export interface MetadataClient {
  listApps(): Promise<MetadataApp[]>;
  listObjects(app?: string): Promise<MetadataObject[]>;
  describeObject(apiName: string): Promise<ObjectDescriptor>;
}

export class EmptyMetadataClient implements MetadataClient {
  async listApps(): Promise<MetadataApp[]> {
    return [];
  }

  async listObjects(_app?: string): Promise<MetadataObject[]> {
    return [];
  }

  async describeObject(apiName: string): Promise<ObjectDescriptor> {
    throw new Error(`No metadata source is configured for '${apiName}'. Inspect the connected repo and target app instead.`);
  }
}
