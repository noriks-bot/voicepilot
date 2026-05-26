module.exports = {
  apps: [{
    name: 'voicepilot',
    script: 'server.js',
    cwd: '/home/ec2-user/voicepilot',
    env: {
      NODE_ENV: 'production',
      PORT: '3008'
    }
  }]
};
