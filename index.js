/**
 * 功能需求:
 * 上传指定文件夹到远程
 *
 * 细节需求:
 * 1.可以指定无需上传的文件/文件夹
 * 2.对于文件内容相同的文件不得进行覆盖
 * 3.上传期间锁定目录,防止多人操作冲突
 * 4.可以指定线程数量
 * 5.兼容mac,win系统
 *
 * 对应实现思路:
 * 1.https://github.com/isaacs/node-glob
 * 2.例如上传目录下有个文件的内容为content
 * 那么每次上传之后,根据该文件的内容,生成一个唯一的标识：md5(content)+sha1(content) [ps: md5和sha1是加密算法]
 * 每次上传之后都把所有文件的标识存入一个文件(暂且叫地图文件)里面
 * 在上传之前先把地图文件下载到本地,然后与本地的文件的标识做比较,找出内容有变化的文件进行上传
 * 3.上传开始时在远程地址下创建一个文件锁,在程序开始时检测远程地址是否有文件锁
 * 4.暂时略过,作为后续优化项
 * 5.对于win32系统来说,主要问题是路径里面的反斜线(\)需要替换成正斜线(/)
 *
 * module.exports = function(opts){}
 * opts:
 * {
 *  src: '',                    // 要上传的文件夹的绝对路径 eg from: /local/path/to/test
 *  dest: '',                   // 上传到的远程绝对路径        to:  /remote/path/to/test
 *  exclusions: [],             // 需要排除的文件规则,默认从src目录开始匹配
 *  excludeOptions: {           // 参考glob模块的options配置参数
 *      cwd: src,
 *      root: src
 *  },
 *  folder: '__atm__',          // 文件锁和地图文件所在远程服务器文件夹名称,默认为 __atm__
 *  force: false,               // 是否在远程目录锁定时强制上传
 *  auth: {                     // 上传配置,参照scp2模块
 *      host: '',
 *      username: '',
 *      password: ''
 *  },
 *  interval: 1000*3600*24*15      //创建时间超过15天的临时目录可以删除,主要防止runtime文件夹下无用的文件夹太多,一般不用设置该参数
 * }
 *
 * 用法
 * var deploy = require('atm-scp');
 * deploy(opts);
 *
 * 开发相关
 * https://github.com/spmjs/node-scp2
 * https://github.com/isaacs/node-glob
 * https://github.com/jprichardson/node-fs-extra
 *
 * https://github.com/lodash/lodash
 *
 */

var path = require('path');
var crypto = require('crypto');
var fs = require('fs-extra');
var extend = require('extend');
var client = require('scp2');
var glob = require('glob');

var win32 = process.platform === 'win32'? true: false;
module.exports = function(opts){
    opts = extend(true, {
        folder: '__atm__',
        exclusions: ['**/.DS_Store', '**/Thumbs.db'],
        force: false,
        excludeOptions: {},
        interval: 1000*3600*24*15      //创建时间超过15天的临时目录可以删除
    }, opts);

    var T = {};

    var lockTxt = opts.folder + '/lock.txt';
    var mapJson = opts.folder + '/map.json';
    var unique = 1;
    var timestamp = Date.now();
    var tempDir = path.join(__dirname, 'runtime', String(timestamp));      //临时文件夹,存放临时文件,上传完毕后删除该目录
    var src = opts.src;      // 要上传的本地文件夹绝对路径
    var dest = opts.dest;    // 远程文件夹绝对路径
    opts.excludeOptions = extend(true, {
        cwd: src,
        root: src
    }, opts.excludeOptions);


    // 删除其他项目创建的但由于运行失败而未成功删除的临时目录(1天前的项目)
    new Promise(function(resolve, reject){
        var runtimeDir = path.dirname(tempDir);
        fs.readdir(runtimeDir, function(err, files){
            for(var i in files){
                var tempName = parseInt(files[i]);

                if(timestamp-tempName > opts.interval){
                    var tempDir = path.join(runtimeDir, files[i]);
                    try{
                        fs.removeSync(tempDir)
                    }catch(err){
                        error(err, '清除['+tempDir+']失败');
                    }
                }
            }
            resolve();
        });

    })

        // 设置权限
        .then(function(){
            client.defaults(opts.auth);
        })

        // 判断目录是否锁定
        .then(function(){
            return new Promise(function(resolve, reject){
                var remoteLock = join(dest, lockTxt);
                remoteExists(remoteLock, function(exist, content){
                    // 如果远程文件存在切内容为true,说明文件已锁定
                    if(exist && content=='true'){
                        if(opts.force){  // 如果配置中设置强行上传,则继续执行
                            resolve();
                        }else{  // 否则终止运行
                            throw new Error('目录已被锁定')
                        }
                    }else{  // 远程文件没有锁定则继续执行
                        resolve();
                    }
                })
            })
        })

        // 创建本地文件锁
        .then(function(){
            return new Promise(function(resolve, reject){
                var localLock = join(tempDir, lockTxt);
                fs.outputFile(localLock, 'true', function(err){
                    error(err, '创建/写入本地文件锁失败', '创建本地文件锁成功');
                    resolve();
                });
            });
        })

        // 上传文件锁
        .then(function(){
            return new Promise(function(resolve, reject){
                var localLock = join(tempDir, lockTxt);
                var remoteLock = join(dest, lockTxt);
                client.upload(localLock, remoteLock, function(err){
                    error(err, '上传文件锁失败', '成功锁定远程目录');
                    resolve();
                });
            });
        })

        // 获取远程地图文件
        .then(function(){
            var remoteMap = join(dest, mapJson);
            return new Promise(function(resolve, reject){
                remoteExists(remoteMap, function(exist, content){
                    if(exist){  // 如果远程地图文件已存在
                        T.map = JSON.parse(content)
                    }
                    resolve();
                });
            });
        })

        // 获取本地文件&文件夹数组
        .then(function(){
            return new Promise(function(resolve, reject){
                var localMap = {}
                function getData(route){
                    var dir = route? join(src, route): src;
                    !route && (route='');
                    try{
                        var files = fs.readdirSync(dir);
                    }catch(err){
                        error(err, '读取['+dir+']目录失败');
                    }
                    files.forEach(function(file){
                        var filePath = join(dir, file);
                        try{
                            var stats = fs.statSync(filePath);
                            var id = join(route, file);
                            if(stats.isFile()){
                                try{
                                    var content = fs.readFileSync(filePath);
                                }catch(err){
                                    error(err, '读取本地文件['+filePath+']失败');
                                }

                                localMap[id] = getHash(content);
                            }else if(stats.isDirectory()){
                                getData(id);
                            }
                        }catch(err){
                            // 文件不存在
                            console.log('['+filePath+']文件无法上传')
                        }
                    });

                }
                getData();
                T.localMap = localMap;
                resolve();
            })
        })

        // 获取过滤掉的文件
        .then(function(){
            var arr = opts.exclusions;
            if( arr && arr.length ){
                var len = arr.length;
                var pattern = len>1? '{'+arr.join(',')+'}': arr[0];
                return new Promise(function(resolve, reject){
                    glob(pattern, opts.excludeOptions, function (er, exclusions) {
                        resolve(exclusions);
                    });
                });
            }else{
                return [];
            }
        })
        // 获取需要上传的文件数组
        .then(function(exclusions){
            var uploadArr = [];
            var map = T.map || (T.map = {});
            var localMap = T.localMap;
            for(var id in localMap){
                if(localMap[id] != map[id]){
                    // 如果文件没有被排除则放入上传数组
                    if( exclusions.indexOf(id)===-1 ){
                        uploadArr.push(id);
                        map[id] = localMap[id];
                    }
                }
            }
            T.uploadArr = uploadArr;
        })

        // 上传需要上传的文件
        .then(function() {
            if(!T.uploadArr.length){
                console.log('所有文件无需上传!');
                return;
            }
            return new Promise(function (resolve, reject) {
                var uploadArr = T.uploadArr;
                function uploadFile() {
                    var len = uploadArr.length
                    if(len){
                        console.log('还有'+len+'个文件等待上传');
                        var id = uploadArr.shift();
                        console.log('正在上传['+id+']');
                        var localFile = join(src, id)
                        var remoteFile = join(dest, id);
                        client.upload(localFile, remoteFile, function (err) {
                            error(err, '上传文件[' + localFile + ']失败');
                            uploadFile();
                        })
                    } else {
                        console.log('文件已同步完毕');
                        resolve();
                    }
                }
                uploadFile();
            })
        })

        // 重置远程文件地图
        .then(function(){
            return new Promise(function(resolve, reject){
                var buffer = new Buffer(JSON.stringify(T.map), 'utf-8');
                client.write({
                    destination: join(dest, mapJson),
                    content: buffer
                }, function(err){
                    error(err, '地图文件更新失败', '地图文件已更新');
                    resolve();
                });
            })
        })

        // 解除锁定
        .then(function(){
            return new Promise(function(resolve, reject){
                // 设置锁定文件内容为false
                client.write({
                    destination: join(dest, lockTxt),
                    content: new Buffer('false', 'utf-8')
                }, function(err){
                    error(err, '文件解除锁定时出错', '模块锁定已解除');
                    resolve();
                });
            })
        })
        // 删除临时目录
        .then(function(){
            return new Promise(function(resolve, reject){
                fs.remove(tempDir, function (err) {
                    error(err, '删除临时目录失败', '删除临时目录成功')
                    resolve();
                });
            });
        })

        // 关闭上传通道
        .then(function(){
            client.close();
            console.log('文件发布完成!!!')
        });


    // 判断远程文件是否存在
    // 回调函数cb的第一个参数是yes/no
    // 如果cb的第一个参数是yes,第二个参数是远程文件的内容
    function remoteExists(remotePath, cb){
        var localPath = getFileRandom();

        // 先创建文件夹
        fs.ensureDir(path.dirname(localPath), function (err) {
            error(err, '确定临时文件夹是否存在时出错');
            client.download(remotePath, localPath, function(err){
                if(err){
                    if(err.type=='NO_SUCH_FILE'){
                        //文件不存在
                        fs.unlink(localPath, function(err){
                            if(err){ throw err; }
                        });
                        cb && cb(false);
                    }else{
                        throw err;
                    }
                }else{
                    //文件存在
                    fs.readFile(localPath, 'utf-8', function(err, content){
                        if(err){ throw err; }
                        fs.unlink(localPath, function(err){
                            if(err){ throw err; }
                        });
                        cb && cb(true, content);
                    });
                }
            });
        })

    }

    // 动态生成一个临时文件路径
    function getFileRandom(){
        var rand = 'file-'+(unique++)+'.txt';
        return join(tempDir, rand);
    }

}

// 替换win平台路径里面的'\'为'/'
function join(){
    var str = path.join.apply(path, Array.prototype.slice.call(arguments));
    str = win32? str.replace(/\\/g,'/'): str;
    return str;
}
// 根据内容获取标识
function getHash(contents){
    return getMd5(contents)+getSha(contents);
}
function getMd5(contents){
    var md5 = crypto.createHash('md5');
    md5.update(contents);
    return md5.digest('hex');
}
function getSha(contents){
    var sha = crypto.createHash('sha1');
    sha.update(contents);
    return sha.digest('hex');
}

// 如果存在错误,则直接终止程序执行
function error(err, msg, tip){
    if(err){
        msg && console.log(msg);
        throw err;
    }else{
        tip && console.log(tip);
    }
}
