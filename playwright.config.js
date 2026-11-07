const { defineConfig, devices } = require('@playwright/test');
module.exports=defineConfig({
  testDir:'./tests',
  timeout:60000,
  workers:1,
  reporter:[['list'],['html',{open:'never'}]],
  projects:[
    {
      name:'chromium',
      testMatch:'**/viewer.spec.js',
      use:{launchOptions:{
        ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
        args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']
      }}
    },
    {
      // The WebKit engine on Linux, with an iPhone-sized touch screen. It is not iOS Safari: it shows
      // whether the page runs on WebKit at all, not how a real iPhone behaves. Run with `npm run test:webkit`.
      name:'webkit',
      testMatch:'**/webkit-smoke.spec.js',
      use:{...devices['iPhone 13']}
    }
  ]
});
