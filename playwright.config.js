const { defineConfig } = require('@playwright/test');
module.exports=defineConfig({testDir:'./tests',use:{launchOptions:{...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']}}});
