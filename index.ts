import * as os from 'os';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as path from 'path';
import * as events from 'events';
import * as urlLib from 'url';
import * as gitclient from 'git-fetch-pack';
import * as transport from 'git-transport-protocol';
import * as semverSort from 'semver-sort';
import * as extract from 'extract-zip';
import * as DecompressZip from 'decompress-zip';
import { http, https } from 'follow-redirects';

const dsFeedUrlTemp =
  'https://github.com/open-numbers/ddf--gapminder--systema_globalis/archive/v#version#.zip';
const dsGithubOwner = 'open-numbers';
const dsGithubRepo = 'ddf--gapminder--systema_globalis';
const isWin = /^win32/.test(os.platform());

(async function () {
  const tagVersion = await getLatestGithubTag(`github.com/${dsGithubOwner}/${dsGithubRepo}`);
  const destDir = path.resolve('target');
  const em = new events.EventEmitter();

  em.on('ds-update-status', (status: string) => {
    console.log(status);
  });

  try {
    await updateDataset(tagVersion, destDir, em);
    console.log('ok');
  } catch (e) {
    console.log(e);
  }
})();

async function updateDataset(tagVersion: string, destDir: string, em: events.EventEmitter) {
  const dsFeedUrl = dsFeedUrlTemp.replace('#version#', tagVersion);
  const tempPath = path.resolve('temp');
  await removeDir(tempPath);
  em.emit('ds-update-status', 'Downloading dataset archive...');
  const dlFile = await download({ url: dsFeedUrl, path: tempPath, file: 'dl.zip' });
  const unpackFun = isWin ? unpackWin : unpackNix;
  em.emit('ds-update-status', 'Unpacking dataset archive...');
  const unpacked = await unpackFun({ fullPath: dlFile, target: path.resolve(tempPath, 'unpacked') });
  const contentDir = await getFirstDir(unpacked);
  em.emit('ds-update-status', 'Updating existing dataset...');
  await copy(contentDir, destDir);
  await removeDir(tempPath);
}

async function copy(source: string, dest: string): Promise<void> {
  return new Promise((resolve: Function, reject: Function) => {
    fse.copy(source, dest, err => {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  });
}

async function getFirstDir(baseDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readdir(baseDir, (err, files) => {
      if (err) {
        return reject(err);
      }

      if (files.length !== 1) {
        return reject();
      }

      resolve(path.resolve(baseDir, files[0]));
    });
  });
}

async function getLatestGithubTag(inputParam: string): Promise<string> {
  return new Promise((resolve: Function, reject: Function) => {
    const input = inputParam.replace(/^(?!(?:https|git):\/\/)/, 'https://');
    const tcp = net.connect({ host: urlLib.parse(input).host, port: 9418 });
    const client = gitclient(input);
    const tags = [];

    client.refs.on('data', ref => {
      const name = ref.name;

      if (/^refs\/tags/.test(name)) {
        tags.push(name.split('/')[2].replace(/\^\{\}$/, '').substr(1));
      }
    });

    client
      .pipe(transport(tcp))
      .on('error', reject)
      .pipe(client)
      .on('error', reject)
      .once('end', () => {
        if (tags.length === 0) {
          return reject('Tags are missing');
        }

        resolve(semverSort.desc(tags)[0]);
      });
  });
}

async function removeDir(what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fse.remove(what, err => {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  });
}

async function unpackWin(options: {fullPath: string, target: string}): Promise<string> {
  const unzipper = new DecompressZip(options.fullPath);
  const targetPath = path.resolve(options.target);

  return new Promise((resolve: Function, reject: Function) => {
    unzipper.on('error', reject);
    unzipper.on('extract', () => {
      resolve(targetPath);
    });

    unzipper.extract({
      path: targetPath,
      follow: true
    });
  });
}

async function unpackNix(options): Promise<string> {
  const targetPath = path.resolve(options.target);

  return new Promise((resolve: Function, reject: Function) => {
    extract(options.fullPath, { dir: targetPath }, err => {
      if (err) {
        return reject(err);
      }

      resolve(targetPath);
    });
  });
};

async function download(options: {url: string, path: string, file: string}): Promise<string> {
  return new Promise((resolve: Function, reject: Function) => {
    const TIMEOUT = 240000;
    const mode = parseInt('0777', 8) & (~process.umask());

    fs.mkdir(options.path, mode, pathErr => {
      if (pathErr) {
        return reject(pathErr);
      }

      const filePath = path.resolve(options.path, options.file);
      const file = fs.createWriteStream(filePath);
      const timeoutWrapper = req => () => {
        req.abort();
        reject('File transfer timeout!');
      };

      const relatedLib = options.url.indexOf('https://') === 0 ? https : http;
      const request = relatedLib.get(options.url)
        .on('response', res => {
          res.on('data', chunk => {
            file.write(chunk);

            clearTimeout(timeoutId);
            timeoutId = setTimeout(timeoutAction, TIMEOUT);
          }).on('end', () => {
            clearTimeout(timeoutId);
            file.end();

            resolve(filePath);
          }).on('error', err => {
            clearTimeout(timeoutId);

            reject(err);
          });
        });

      const timeoutAction = timeoutWrapper(request);

      let timeoutId = setTimeout(timeoutAction, TIMEOUT);
    });
  });
}
