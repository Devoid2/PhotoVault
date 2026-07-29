#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.request

repo = os.environ['REPO']
tag = os.environ['TAG']
prev = os.environ['PREV_TAG']
changelog = os.environ['CHANGELOG']
token = os.environ['GH_TOKEN']

body = (
    "## What's Changed\n\n"
    + changelog + "\n\n"
    + f"**Full Changelog**: https://github.com/{repo}/compare/{prev}...{tag}\n\n"
    + "### Downloads\n"
    + f"- [macOS (DMG)](https://github.com/{repo}/releases/download/{tag}/PhotoVault-{tag}-universal.dmg)\n"
    + f"- [Windows (Setup)](https://github.com/{repo}/releases/download/{tag}/PhotoVault-Setup-{tag}.exe)"
)

headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
}

mode = os.environ.get('MODE', 'create')


def request_json(url, method='GET', data=None):
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


if mode == 'create':
    existing = request_json(f"https://api.github.com/repos/{repo}/releases/tags/{tag}")
    if existing:
        rid = existing['id']
        print(f"Deleting existing release {rid}...")
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/releases/{rid}",
            method='DELETE',
            headers=headers,
        )
        with urllib.request.urlopen(req):
            pass

    payload = json.dumps({
        "tag_name": tag,
        "name": tag,
        "draft": True,
        "body": body,
    })
    created = request_json(
        f"https://api.github.com/repos/{repo}/releases",
        method='POST',
        data=payload.encode(),
    )
    print(f"Draft release created: {created['html_url']}")

elif mode == 'publish':
    release = request_json(f"https://api.github.com/repos/{repo}/releases/tags/{tag}")
    if not release:
        payload = json.dumps({
            "tag_name": tag,
            "name": tag,
            "draft": False,
            "body": body,
        })
        created = request_json(
            f"https://api.github.com/repos/{repo}/releases",
            method='POST',
            data=payload.encode(),
        )
        print(f"Release created: {created['html_url']}")
        raise SystemExit(0)

    rid = release['id']
    payload = json.dumps({
        "body": body,
        "draft": False,
    })
    updated = request_json(
        f"https://api.github.com/repos/{repo}/releases/{rid}",
        method='PATCH',
        data=payload.encode(),
    )
    print(f"Release published: {updated['html_url']}")
