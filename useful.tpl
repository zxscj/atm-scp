var deploy = require('atm-scp');
deploy({
    src: '/local/path/to/test',
    dest: '/remote/path/to/test',
    exclusions: ['**/.DS_Store', '**/Thumbs.db'],
    auth: {
        host: '*.*.*.*',
        username: 'username',
        password: 'password'
    }
});