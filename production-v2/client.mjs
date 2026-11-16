import { FeishuClient } from '../lib/feishu.mjs';

/** v2 writes return immediately on rate limits; persistent jobs own retries. */
export class WorkflowClient extends FeishuClient {
  constructor(config = {}, options = {}) {
    super(config, { ...options, retryMutations: false });
  }
}
