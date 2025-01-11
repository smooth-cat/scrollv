## v2

### 事件

1. slotchange 微任务
   1. 根据当前渲染情况决定是否补充渲染3
   2. 监听+统计这一屏元素 size，给 wheel 做计算使用
2. wheel
   1. 计算后 start end 不变，应该直接修改 sTop 这一任务完成计算
   2. start end 不同，应该到 [1. slotchange] 中 进行渲染完成后的判断
3. item ResizeObserver
4. wrapper ResizeObserver