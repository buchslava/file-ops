import * as os from 'os';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as path from 'path';
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

getLatestGithubTag(`github.com/${dsGithubOwner}/${dsGithubRepo}`, (tagError, tagVersion) => {
  const dsFeedUrl = dsFeedUrlTemp.replace('#version#', tagVersion);
  const tempPath = path.resolve('temp');

  download({
    url: dsFeedUrl,
    path: tempPath,
    file: 'dl.zip'
  }, (downloadErr, file) => {
    const unpackFun = isWin ? unpackWin : unpackNix;

    unpackFun({
      fullPath: file,
      target: path.resolve(tempPath, 'unpacked')
    }, (unpackErr) => {
      console.log(unpackErr);
    });
  });
});

function getLatestGithubTag(inputParam: string, onTagReady: Function) {
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
    .on('error', onTagReady)
    .pipe(client)
    .on('error', onTagReady)
    .once('end', () => {
      if (tags.length === 0) {
        return onTagReady(Error('Tags are missing'));
      }

      onTagReady(null, semverSort.desc(tags)[0]);
    });
}

function unpackWin(options, onUnpacked) {
  const unzipper = new DecompressZip(options.fullPath);

  unzipper.on('error', onUnpacked);
  unzipper.on('extract', () => onUnpacked());

  unzipper.extract({
    path: path.resolve(options.target),
    follow: true
  });
}

function unpackNix(options, onUnpacked) {
  extract(options.fullPath, { dir: path.resolve(options.target) }, onUnpacked);
};

function download(options, onDownloadCompleted) {
  const TIMEOUT = 240000;
  const mode = parseInt('0777', 8) & (~process.umask());

  fs.mkdir(options.path, mode, pathErr => {
    if (pathErr) {
      onDownloadCompleted(pathErr);
      return;
    }

    const filePath = path.resolve(options.path, options.file);
    const file = fs.createWriteStream(filePath);
    const timeoutWrapper = req => () => {
      req.abort();
      onDownloadCompleted('File transfer timeout!');
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

          onDownloadCompleted(null, filePath);
        }).on('error', err => {
          clearTimeout(timeoutId);

          onDownloadCompleted(err.message);
        });
      });

    const timeoutAction = timeoutWrapper(request);

    let timeoutId = setTimeout(timeoutAction, TIMEOUT);
  });
}
