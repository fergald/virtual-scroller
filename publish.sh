#! /bin/bash -ex
# Publish a sha and/or branch to gh-pages.
#
# publish.sh <sha>
#
# Will cause the repo to be published under
# https://fergald.github.io/virtual-scroller/versions/<sha>
# and
#
# publish.sh <branch>
#
# will figure out the sha for that branch, publish that and
# link versions/<branch> to that sha.

if [ ! -e .git ]; then
    echo >2 No .git
    exit 1
fi

if [ $# -eq 0 ]; then
    echo >2 No revision
    exit 1
fi

revision=$1
shift

git checkout gh-pages

sha=$(git rev-parse "$revision")
dest=versions/"$sha"
git clone -s -n . "$dest"
(
    cd "$dest"
    git checkout "$sha"
    echo Deleting `pwd`/.git
    read f
    rm -rf .git
    git add .
    git commit -a -m"Add gh-pages revision $sha"

    if [ "$sha" = "$revision" ]; then
        exit
    fi

    cd ..
    ln -sfT "$sha" "$revision"
    git add "$revision"
    git commit -a -m"Update $revision->$sha"
)
git push

git checkout -
base=$(git remote show -n origin|grep "Fetch URL" | perl -lne 'print "https://$1.github.io/$2" if m#github.com:(.*?)/(.*)#')
if [ -z "$base" ]; then
    echo >2 "Couldn't get base"
    exit 1
fi

echo Published to "$base/versions/$revision"
if [ "$sha" != "$revision" ]; then
    echo Published to "$base/versions/$sha"
fi
