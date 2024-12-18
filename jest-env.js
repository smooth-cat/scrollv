/** 由于 jest 提供的默认 dom 环境不具备 MessageChannel，这里使用 node:worker_threads 模拟
 */

const { MessageChannel } = require('node:worker_threads');
const DomEnv = require('jest-environment-jsdom').TestEnvironment;
class CustomEnvironment extends DomEnv {
  async setup() {
    const res = await super.setup();
    this.global['MessageChannel'] = MessageChannel;
    /**
     * 满足如下文件头注释的会触发
     * @my-custom-pragma my-pragma-value
     */
    // if (this.docblockPragmas['my-custom-pragma'] === 'my-pragma-value') {
    // }
    return res;
  }
}

module.exports = CustomEnvironment;