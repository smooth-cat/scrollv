# scrollv
一个基于 Web Component 的虚拟滚动库

🌰：包含 1000 个随机高度项的虚拟列表

```html
<head>
  <script src="./dist/scrollv.umd.js"></script>
  <script>Scrollv.define('scroll-v', Scrollv.AutoHeight)</script>
</head>
<body>
  <button id="btn">滚动</button>
  <!-- 
   1. style      容器宽高由外部决定
   2. total      代表渲染列表总条目数
   3. itemHeight 预期的高度
   4. pad?:      在屏幕外缓存区域
   5. passive?:  不需要执行 preventDefault 时开启可以优化滚动效果
   6. rate?:     滚动倍率
   -->
  <scroll-v 
    style="height: 60vh; width: 300px;" 
    total="1000" 
    itemHeight="150" 
    pad="300"
    passive="true"
    rate="1"
  />
</body>
<script>
  // mock 1000 random height data
  const data = Array.from({ length: 1000 }, (_, i) => ({
    height: 150 + Math.random() * 200,
    i,
  }));

  // slice 事件触发时重新渲染可视区域
  scrollv.addEventListener('slice', (e) => {
    const { start, end } = e.detail;
    scrollv.innerHTML = data.slice(start, end).map((item) =>
      `<div style="height: ${item.height}px; border: 1px solid black;">
        ${item.i}
     </div>`
    ).join('');
  });

  // 使用 delta 滚动方式， 向下滚动 1000px
  btn.addEventListener('click', () => {
    scrollv.scrollv('delta', { dt: 1000 })
  })
</script>
```