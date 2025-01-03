export type Func = (...args: any[]) => any;

const None = Symbol('none');
export const timestamp = globalThis.performance ? globalThis.performance.now.bind(globalThis.performance) : Date.now;

export enum EventMode {
  Immediate,
  Queue,
}

export enum ProcessStatus {
  None,
  Processing,
  Paused,
}

const DefaultEventOpt = {
  mode: EventMode.Immediate,
};

const ALL = '__ALL_KEY';

export type IEventOpt = Partial<typeof DefaultEventOpt>;

export type IScheduler = (doCall: Func, ...args: any[]) => void;
export type IGlobalScheduler = (goOn: () => void) => void;
export type ISetScheduler = {
  (type: string, scheduler: IScheduler): void;
  (scheduler: IGlobalScheduler): void;
};

export type IEventItem = {
  type: string;
  args: any[];
  time: number;
};

export class BaseEvent {
  constructor(private opt: IEventOpt = {}) {
    this.opt = { ...DefaultEventOpt, ...opt };
  }
  scheduler?: IGlobalScheduler;
  eventQueue: IEventItem[] = [];
  status = ProcessStatus.None;
  subMap = new Map<string, Set<Func>>();
  on = (type: string | undefined, fn: Func) => {
    if (type == null) type = ALL;
    const suber = this.subMap.get(type) || new Set<Func>();
    suber.add(fn);
    this.subMap.set(type, suber);
  };

  off = (type: string | undefined, fn: Func) => {
    const suber = this.subMap.get(type ?? ALL);
    if (!suber) return;
    suber.delete(fn);
  };

  once = (type: string | undefined, fn: Func) => {
    fn['once'] = true;
    this.on(type, fn);
  };

  setScheduler: ISetScheduler = (type: string | IGlobalScheduler, scheduler?: Func) => {
    if (typeof type !== 'string') {
      this.scheduler = type;
      return;
    }
    const set = this.subMap.get(type) || new Set<Func>();
    set['scheduler'] = scheduler;
    this.subMap.set(type, set);
  };

  callSub(it: Func, fns, args) {
    const doCall = (...args) => {
      it(...args);
      if (it['once'] === true) fns.delete(it);
    };
    const scheduler = it['scheduler'] || fns['scheduler'];

    if (scheduler) {
      scheduler(doCall, ...args);
    } else {
      it(...args);
      if (it['once'] === true) fns.delete(it);
    }
  }

  // construct 会初始化为下面其中一种
  emit = (type: string, ...args: any[]) => {
    this.opt.mode === EventMode.Immediate
      ? this.emitImmediate(type, ...args)
      : this.emitQueue(type, ...args);
  };
  
  emitImmediate(type: string, ...args: any[]) {
    const fns = this.subMap.get(type);
    const allSub = this.subMap.get(ALL);
    fns?.forEach((it) => this.callSub(it, fns, args));
    allSub?.forEach((it) => this.callSub(it, allSub, args));
  }

  emitQueue(type: string, ...args: any[]) {
    this.eventQueue.push({ type, args, time: timestamp() });
    this.process();
  }

  pause = () => (this.status = ProcessStatus.Paused);
  unPause = () => (this.status = ProcessStatus.None);
  start = () => {
    this.status = ProcessStatus.None;
    this.processQueue();
  };

  process = () => {
    if (this.scheduler) {
      return this.scheduler(this.recallScheduler);
    }
    return this.processQueue();
  }

  recallScheduler = () => {
    this.scheduler!(this.recallScheduler);
  };

  processQueue = () => {
    // 如果是挂起状态则直接结束
    if (this.status === ProcessStatus.Paused) return;
    this.status = ProcessStatus.Processing;

    let { type, args } = this.eventQueue.shift() || {};
    if (type) {
      // 在此过程中用户可通过 pause 和 start 同步控制事件处理
      const fns = this.subMap.get(type);
      const allSub = this.subMap.get(ALL);
      fns?.forEach((it) => this.callSub(it, fns, args));
      allSub?.forEach((it) => this.callSub(it, allSub, args));
      if (this.eventQueue.length > 0) {
        this.processQueue();
      }
    }
    //@ts-ignore 队列全部处理完成，如果执行过程中被 pause 
    if(this.status !== ProcessStatus.Paused) {
      this.status = ProcessStatus.None;
    }
  };


  dispatchEvent = (iList: number[]) => {
    // 从大到小排序
    iList.sort((a, b) => b - a);
    iList.forEach((idx) => {
      const [item] = this.eventQueue.splice(idx, 1);
      const { type, args } = item || {};
      if (type && args) {
        this.emitImmediate(type, ...args);
      }
    });
  };

  clear = () => {
    this.subMap.clear();
    this.eventQueue = [];
    this.scheduler = undefined;
  };
}

export class EventNode extends BaseEvent {
  constructor() {
    super({ mode: EventMode.Queue });
  }
  pipe = (type: string, ...fns: (Func | PipeNode)[]) => {
    const { firstNode, lastNode } = this.buildPip(fns);
    // 将第一个节点与事件源节点关联
    this.on(type, (...args) => firstNode.emit('process', args));
    return lastNode;
  };

  buildPip = (fns: (Func | PipeNode)[]) => {
    const startWithPipeNode = fns[0] instanceof PipeNode;
    let firstNode: PipeNode;
    // @ts-ignore
    let curNode: PipeNode = (firstNode = startWithPipeNode ? fns[0] : new PipeNode());
    let i = startWithPipeNode ? 1 : 0;
    let toAdd: Func[] = [];
    while (i < fns.length) {
      const it = fns[i];
      if (!(it instanceof PipeNode)) {
        toAdd.push(it);
        continue;
      }

      // 遇到下一个 pipeNode，把上一个完成
      curNode.pipList = toAdd;
      toAdd = [];
      curNode.on('finish', (args) => it.emit('process', args));

      curNode = it;
      i++;
    }
    // 处理最后一个节点
    curNode.markLast();
    curNode.pipList = toAdd;
    return {
      firstNode,
      lastNode: curNode,
    };
  };

  preProcessMap = new Map<string, [PipeNode, PipeNode]>();
  preProcess = (type: string, ...fns: (Func | PipeNode)[]) => {
    const { firstNode, lastNode } = this.buildPip(fns);
    this.preProcessMap.set(type, [firstNode, lastNode]);
  };

  emit = (type: string, ...args: any[]) => {
    const [firstNode, lastNode] = this.preProcessMap.get(type) || [];
    if (firstNode && lastNode) {
      lastNode.once('real-finish', (...args) => {
        // 等待预处理完成后再开始触发事件，且修正 args
        this.eventQueue.push({ type, args, time: timestamp() });
        this.start();
      });
      this.pause();
      firstNode.emit('process', args);
    } else {
      this.emitQueue(type, ...args);
    }
  };

  from(type: string, promise?: Promise<any>) {
    if (promise) {
      promise.then(
        (value) => {
          this.emit(type, value);
        },
        (err) => {
          this.emit(type, err);
        },
      );
      return;
    }

    return (...args: any[]) => {
      this.emit(type, ...args);
    };
  }
}

export class PipeNode extends BaseEvent {
  public pipList: Func[] = [];

  onFinish = (fn: Func) => {
    this.on('real-finish', fn);
  };

  isLastNode = false;

  markLast = () => (this.isLastNode = true);

  constructor() {
    super({ mode: EventMode.Queue });
    this.on('process', async (args) => {
      let res;
      for (const pipeFn of this.pipList) {
        try {
          res = pipeFn(...args);
          if (res instanceof Promise) {
            res = await res;
          }
        } catch (error) {
          res = error;
        }
        args = [res];
      }
      if (this.isLastNode) {
        this.emitImmediate('real-finish', ...args);
      } else {
        this.emitImmediate('finish', args);
      }
    });
  }
}