#!/usr/bin/env python3
import json, os, urllib.request, urllib.error

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
    "Content-Type": "application/json"
}

mode = os.environ.get('MODE', 'create')

if mode == 'create':
    # Delete existing release if any, then create new one (draft, so electron-builder can upload)
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
        headers=headers
    )
    try:
        resp = urllib.request.urlopen(req)
        existing = json.loads(resp.read())
        rid = existing['id']
        print(f"Deleting existing release {rid}...")
        del_req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/releases/{rid}",
            method='DELETE',
            headers=headers
        )
        urllib.request.urlopen(del_req)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    # Create draft release
    payload = json.dumps({
        "tag_name": tag,
        "name": tag,
        "draft": True,
        "body": body
    })
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases",
        method='POST', data=payload.encode(), headers=headers
    )
    resp = urllib.request.urlopen(req)
    created = json.loads(resp.read())
    print(f"Draft release created: {created['html_url']}")

elif mode == 'publish':
    # Get release, update body and publish (draft: False)
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
        headers=headers
    )
    resp = urllib.request.urlopen(req)
    release = json.loads(resp.read())
    rid = release['id']

    payload = json.dumps({
        "body": body,
        "draft": False
    })
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/{rid}",
        method='PATCH', data=payload.encode(), headers=headers
    )
    resp = urllib.request.urlopen(req)
    updated = json.loads(resp.read())
    print(f"Release published: {updated['html_url']}")