const { setupProxy } = require('./src/server/proxy');

setupProxy();

const { createApp } = require('./src/server/app');

const PORT = process.env.PORT || 41119;

createApp().then(app => {
  app.listen(PORT, () => {
    console.log(`Mana running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
