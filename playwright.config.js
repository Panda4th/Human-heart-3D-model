const { defineConfig } = require('@playwright/test');
module.exports=defineConfig({
  testDir:'./tests',
  testMatch:'**/*.spec.js',
  timeout:60000,
  workers:1,
  reporter:[['list'],['html',{open:'never'}]],
  use:{launchOptions:{
    ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']
  }}
});
