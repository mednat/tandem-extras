// ==UserScript==
// @name        Tandem extras
// @description filter profiles by 1) gender (name/photo) 2) manual blocklist 3) already-chatted; kbd shortcuts
// @match       *://app.tandem.net/*
// @require     https://unpkg.com/imagehash-web/dist/imagehash-web.min.js
// @require     https://cdn.jsdelivr.net/npm/face-api.js/dist/face-api.min.js
// @require     https://rawcdn.githack.com/mednat/tandem-extras/refs/heads/main/fb-leak_forename_male-probs.js
// @grant       GM.setValue
// @grant       GM.getValue
// @grant       GM.xmlHttpRequest
// @grant       GM.notification
// @top-level-await
// ==/UserScript==

'use strict';

const firstNameMaleProbs = window.firstNameMaleProbs;
const FACEAPI_MODELS_URL = 'https://rawcdn.githack.com/justadudewhohacks/face-api.js/refs/heads/master/weights';

const CHATTED_CACHE = 'chattedCache';
const PROFILE_BLOCKLIST = 'profileBlocklist';
const PHOTO_GENDER_CACHE_KEY = 'photoGenderCache';
const PHASH_TO_ID = 'pHashToId';
const ID_TO_PHASH = 'idToPHash';

unsafeWindow.checkBadCacheVals = async () => {
    [PROFILE_BLOCKLIST, CHATTED_CACHE].forEach(async (gmKey) => {
        if ((await GM.getValue(gmKey, [])).some(x => !x)) console.error(`falsy in ${gmKey}`);
    });
    [ID_TO_PHASH, PHASH_TO_ID].forEach(async (gmKey) => {
        if (Object.entries(await GM.getValue(gmKey, {})).some(([k,v]) => !k || !v)) console.error(`falsy in ${gmKey}`);
    });
    if (Object.entries(await GM.getValue(PHOTO_GENDER_CACHE_KEY, {})).some(([k,v]) => !k || (!v && v!=0))) console.error(`falsy in ${PHOTO_GENDER_CACHE_KEY}`);
};

const handleDoubleKeypress = (() => {
    const keyPresses = new Map();
    return (key, action) => (Date.now() - keyPresses.get(key) < 250) ? action() : keyPresses.set(key, Date.now());
})();

async function waitForElement(selector, documentScope = document.body, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            const element = documentScope.querySelector(selector);
            if (element) {
                observer.disconnect();
                resolve(element);
            }
        });
        observer.observe(documentScope, { childList: true, subtree: true });
        setTimeout(() => (observer.disconnect(), reject(`timeout waiting for element ${selector}`)), timeout);
    });
}

async function loadImage(url) {
    const img = new Image();
    return new Promise(async (resolve, reject) => Object.assign(img, {
        src: URL.createObjectURL((await GM.xmlHttpRequest({
                method: 'GET',
                url,
                responseType: 'blob'
            })).response),
        crossOrigin: 'anonymous',
        onload: () => {
            URL.revokeObjectURL(img.src);
            resolve(img);
        },
        onerror: reject
    }));
}

async function savePhotoHashToId(profileId, img, pHashToId, idToPHash) {
    try {
        const hash = (await phash(img)).toHexString();
        if (hash in pHashToId) console.warn(pHashToId[hash] === profileId ?
                `HASH SELF-COLLISION for ${hash}, id ${profileId}!` :
                `HASH COLLISION for ${hash} between ${profileId} and ${pHashToId[hash]}! overwriting...`
            );

        idToPHash[profileId] = hash;
        pHashToId[hash] = profileId;

        return hash;
    } catch (err) { console.log(`error getting/storing image hash for ${profileId} with url ${imgSrc}: `, err); }
}


const chatsHandler = (() => {
    function navigateChats(direction) {
        const chats = [...document.querySelectorAll('.styles_conversationLink__w7AZy')];
        chats[(direction + chats.findIndex(c => c.classList.contains('styles_active__zmQpO')))]?.click();
    }

    async function deleteChat(chat) {
        const deleteButton = chat.querySelector('button.styles_DeleteButton__R18h8');
        deleteButton.click();
        (await waitForElement('div.styles_popover__JU1jB li.styles_warning__Ge5m5', deleteButton)).click();
        (await waitForElement('button.styles_button__td6Xf.styles_warning__QmUuQ')).click();
    }

    async function blockUserFromChat() {
        console.log('Blocking user from chat page...');
        if (!document.querySelector('.styles_active__zmQpO')) return; // no chat is selected
        try {
            const moreOptionsButton = document.querySelector('button[data-popover="moreOptionsPopover"]');
            moreOptionsButton.click();
            (await waitForElement('i[name="block"]', moreOptionsButton)).click();
            (await waitForElement('button.styles_button__td6Xf.styles_warning__QmUuQ')).click();
        } catch (error) { console.error('Error during UI-based blocking:', error); }
    }

    function onChatKeydown(e) {
        if (e.target.tagName === 'TEXTAREA') return;
        ({
            'j': () => navigateChats(1), //down
            'k': () => navigateChats(-1), //up
            'D': () => handleDoubleKeypress('D', () => {
                const activeChat = document.querySelector('.styles_active__zmQpO');
                if (activeChat) deleteChat(activeChat.closest('.styles_Conversation__IoGWS'));
            }),
            'B': () => handleDoubleKeypress('B', blockUserFromChat),
        }[e.key]?.());
    }

    async function visit(path) {
        if (!path.endsWith('/chats')){
            const chattedCache = new Set(await GM.getValue(CHATTED_CACHE, []));
            chattedCache.add(path.split('/').pop());
            GM.setValue(CHATTED_CACHE, [...chattedCache]);
        }

        document.addEventListener('keydown', onChatKeydown);

        unsafeWindow.deleteChatsWithString = async (s) => {
            for (let chat of document.querySelectorAll('.styles_InfiniteScrollContainer__rYqKF li.styles_Conversation__IoGWS')) {
                if (chat.querySelector('.styles_conversationPreview__qsCW9 p')?.textContent.includes(s)) {
                    await deleteChat(chat);
                    console.debug('deleted chat');
                }
            }
        };

        HTMLElement.prototype.focus = () => {}; // Disable auto-focus chat input to allow for kbd-navigate chatlist
    }

    function cleanup () { document.removeEventListener('keydown', onChatKeydown); }

    return { visit, cleanup };
})();

const profileHandler = (() => {
    function navigateSlideshow(direction) {
        const slidesDiv = document.querySelector('.styles_slides___NkWa');
        if (slidesDiv) (slidesDiv.querySelector(`i[name="arrow_${direction}"]`))?.click();
        else document.querySelector('img.styles_profilePicture__XAMpQ')?.click();
    }

    function createAlertBanner(textContent, backgroundColor) {
        const notification = document.createElement('div');
        Object.assign(notification.style, {
            position: 'fixed',
            top: '65px',
            width: '100%',
            textAlign: 'center',
            padding: '10px',
            color: '#fff',
        });
        notification.className = 'custom-notification';

        notification.textContent = textContent;
        notification.style.backgroundColor =  backgroundColor;

        document.body.appendChild(notification);
    }

    async function toggleProfileBlocklist() {
        const blocklist = new Set(await GM.getValue(PROFILE_BLOCKLIST, []));

        const profileId = location.pathname.split('/').pop();
        console.debug('profile ID to toggle blocklist is: ', profileId);

        if (blocklist.delete(profileId)) {
            await GM.setValue(PROFILE_BLOCKLIST, [...blocklist]);
            createAlertBanner(`Profile ${profileId} removed from blocklist.`, 'rgb(55, 255, 142)');
        } else {
            await GM.setValue(PROFILE_BLOCKLIST, [...blocklist.add(profileId)]);
            createAlertBanner(`Profile ${profileId} added to blocklist.`, 'rgb(255, 55, 112)');
        }
    }

    async function blockUserFromProfile() {
        console.log('Blocking user from profile page...');
        try {
            const moreOptionsButton = document.querySelector('[data-popover="moreOptionsPopover"]');
            moreOptionsButton.click();

            const blockButton = (await waitForElement('.styles_moreOptionsPopover__SYQ_j', moreOptionsButton)).children[1];
            const isBlocked = blockButton.textContent.includes('Unblock');
            blockButton.click();

            if (!isBlocked) {
                (await waitForElement('.styles_button__td6Xf.styles_warning__QmUuQ')).click();
                createAlertBanner(`blocked on Tandem!`, 'rgb(255, 55, 55)');
            } else createAlertBanner(`unblocked on Tandem!`, 'rgb(55, 255, 55)');
        } catch (error) { console.error('Error during UI-based blocking:', error); }
    }

    function onProfileKeydown(e) {
        ({
            'ArrowLeft': () => navigateSlideshow('back'),
            'ArrowRight': () => navigateSlideshow('forward'),
            'Escape': () => document.querySelector('.styles_outsideContent__B7e2g')?.click(), // exit slideshow
            'b': () => handleDoubleKeypress('b', toggleProfileBlocklist),
            'B': () => handleDoubleKeypress('B', blockUserFromProfile),
        }[e.key]?.());
    }

    async function visit(profileId) {
        document.addEventListener('keydown', onProfileKeydown);

        // associate profile photo hash with id
        const idToPHash = await GM.getValue(ID_TO_PHASH, {});
        if (!(profileId in idToPHash)) {
            const pHashToId = await GM.getValue(PHASH_TO_ID, {});
            const imgSrc = (await waitForElement('img.styles_profilePicture__XAMpQ')).src;
            console.debug(`got imgSrc: ${imgSrc}`);

            const hash = await savePhotoHashToId(profileId, await loadImage(imgSrc), pHashToId, idToPHash);

            GM.setValue(ID_TO_PHASH, idToPHash);
            GM.setValue(PHASH_TO_ID, pHashToId);
            console.debug(`saved ${profileId} <> hash: ${hash}`);
        } else console.debug(`already have ${profileId} hash: ${idToPHash[profileId]}`);
    }

    function cleanup () {
        document.removeEventListener('keydown', onProfileKeydown);
        document.querySelectorAll('.custom-notification')?.forEach(el => el.remove());
    }

    return { visit, cleanup };
})();

const listingsHandler = (() => {
    function getStyleForGender(nameMP, faceMP) {
        //FIXME: combine probabilities
        if (nameMP) {
            if (nameMP > 0.7) return { display: 'none' };
            return { backgroundColor: `rgba(255, 130, 185, ${1-nameMP})` };
        }
        if (faceMP) {
            if (faceMP > 0.9) return { display: 'none' };
            return { backgroundColor: `rgba(226, 130, 255, ${1-faceMP})` };
        }
        return {};
    }

    function getGenderByName(rawName) {
        const name = rawName.toLowerCase();
        const plainName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); //no unicode combining chars e.g. diacritics

        if (name in firstNameMaleProbs) return firstNameMaleProbs[name];
        if (plainName in firstNameMaleProbs) {
            console.debug(`found unplain name ${rawName} as ${plainName} in gender lookup`);
            return firstNameMaleProbs[plainName];
        }

        const nameToks = name.split(/[-\s]/);
        const probs = nameToks.map(tok => firstNameMaleProbs[tok]).filter(Boolean);
        if (probs.length) {
            console.debug(`found multi-name ${rawName} in gender lookup with toks ${nameToks}, probs=${JSON.stringify(probs)}`);
            return probs.reduce((sum,p) => sum + p, 0) / probs.length;
        }
    }

    async function getGenderByPhoto(img) {
        const results = await faceapi.detectSingleFace(img).withAgeAndGender();
        if (results) {
            const { gender, genderProbability } = results;
            return gender === 'male' ? genderProbability : 1 - genderProbability;
        }
    }

    async function getGenderByPhotoAndCache(img, id, photoGenderCache) {
        if (id in photoGenderCache) {
            console.debug(`photo gender in cache, id: ${id}`);
            return photoGenderCache[id];
        }

        try {
            const faceGender = await getGenderByPhoto(img);
            if (!faceGender) return console.debug(`no faceapi gender result for ID ${id}`);

            console.debug(`face-api result for id ${id}: ${faceGender} male probability`);
            return photoGenderCache[id] = faceGender;
        } catch (err) { console.error(`error getting face gender for id ${id}`, err); }
    }

    async function filterHighlightedProfiles() {
        console.log('filtering highlighted profiles...');
        const pHashToId = await GM.getValue(PHASH_TO_ID, {});
        const blocklist = new Set(await GM.getValue(PROFILE_BLOCKLIST, []));
        const chattedCache = new Set(await GM.getValue(CHATTED_CACHE, []));
        const photoGenderCache = await GM.getValue(PHOTO_GENDER_CACHE_KEY, {});

        document.querySelectorAll('.styles_HighlightedProfile__fRL2W:not([style*="display: none"])').forEach(async (el) => {
            const {src: imgSrc , alt: name} = el.querySelector('div img');
            if (!imgSrc || !name) return console.error(`bad highlighted-profile element; name: ${name}, imgSrc: ${imgSrc}`, el);

            const img = await loadImage(imgSrc);

            let hash;
            try {
                hash = (await phash(img)).toHexString();
                console.debug(`(from listing) name: ${name}; hash: ${hash}`);
            } catch (err) { console.error(`failure getting image hash for highlighted profile, name: ${name}`, err); }

            let faceGender;
            if (hash in pHashToId) {
                const id = pHashToId[hash];
                console.debug(`hash ${hash} has id ${id}`);

                if (blocklist.has(id) || chattedCache.has(id)) {
                    console.debug(`found id ${id} with hash ${hash} in blocklist or chattedCache, hiding highlighted profile...`);
                    return el.style.display = 'none';
                }
                faceGender = await getGenderByPhotoAndCache(img, id, photoGenderCache);
            } else { faceGender = await getGenderByPhoto(img); }

            Object.assign(el.style, getStyleForGender(getGenderByName(name), faceGender));
        });
    }

    const alreadyFilteredCache = new Set([]);
    let filterProfilesExecution = Promise.resolve();
    async function filterProfiles() { filterProfilesExecution = (async () => {
        await filterProfilesExecution;
        console.log('filterProfiles executing');
        try {
            const blocklist = new Set(await GM.getValue(PROFILE_BLOCKLIST, []));
            const chattedCache = new Set(await GM.getValue(CHATTED_CACHE, []));
            const photoGenderCache = await GM.getValue(PHOTO_GENDER_CACHE_KEY, {});

            const idToPHash = await GM.getValue(ID_TO_PHASH, {});
            const pHashToId = await GM.getValue(PHASH_TO_ID, {});

            await Promise.all([...document.querySelectorAll(
                    '.styles_thumbnail__cFAy3'+
                    ':not(.styles_skeleton__J2O6m)' +
                    ':not([style*="display: none"])'
                )].map(async (el) => {
                    try {
                        const id = el.id;
                        const {src: imgSrc , alt: name} = el.querySelector('div img');
                        if (!id || !imgSrc || !name) return console.error(`bad regular-profile element; id: ${id}, name: ${name}, imgSrc: ${imgSrc}`, el);

                        if (alreadyFilteredCache.has(id) || !alreadyFilteredCache.add(id)) return;

                        let img;
                        if (!(id in idToPHash)) await savePhotoHashToId(id, img = await loadImage(imgSrc), pHashToId, idToPHash);

                        Object.assign(el.style, (blocklist.has(id) || chattedCache.has(id))
                            ? { display: 'none' }
                            : getStyleForGender(
                                getGenderByName(name),
                                await getGenderByPhotoAndCache(img || await loadImage(imgSrc), id, photoGenderCache)
                            )
                        );
                    } catch (err) { throw new Error(`filterProfiles error for ${el.id}`, err); }
                })
            );

            GM.setValue(PHOTO_GENDER_CACHE_KEY, photoGenderCache);
            GM.setValue(ID_TO_PHASH, idToPHash);
            GM.setValue(PHASH_TO_ID, pHashToId);
        } catch (err) {
            console.error('filterProfiles error',err);
            GM.notification({
                title: 'Filter profiles error',
                text: err.message || 'filter profiles errored...',
                timeout: 10000,
                onclick: () => console.log('errornotif clicked')
            });
        }
    })();}

    let faceapiModelsLoading = false;
    const profileListingsObserver = new MutationObserver(filterProfiles);
    async function visit() {
        if (!firstNameMaleProbs) console.error('First-name male-probabilities not loaded!');

        if (!faceapiModelsLoading) {
            faceapiModelsLoading = true;
            await faceapi.nets.ssdMobilenetv1.loadFromUri(FACEAPI_MODELS_URL); // Face detection
            await faceapi.nets.ageGenderNet.loadFromUri(FACEAPI_MODELS_URL);   // Gender detection
            console.log('face-api models loaded!');
        }
        if (!faceapi.nets.ssdMobilenetv1.isLoaded || !faceapi.nets.ageGenderNet.isLoaded) return;

        const waitForListings = new MutationObserver(() => {
            const listingsGrid = document.querySelector('.styles_grid__YwDSM');
            const highlightedProfs = document.querySelector('.styles_track__ElDHy');
            if (listingsGrid && highlightedProfs) {
                waitForListings.disconnect();
                profileListingsObserver.observe(listingsGrid, { childList: true });
                filterProfiles();
                filterHighlightedProfiles();
            }
        });
        waitForListings.observe(document.body, { childList: true, subtree: true });
    }

    function cleanup () {
        profileListingsObserver.disconnect();
        filterProfilesExecution = Promise.resolve();
        alreadyFilteredCache.clear();
    }

    return { visit, cleanup };
})();

function handlePath(path) {
    console.log("path is now:", path);
    [profileHandler, chatsHandler, listingsHandler].forEach(handler => handler.cleanup());

    if (path === '/' || path === '/community') return listingsHandler.visit();
    if (path.includes('/community')) return profileHandler.visit(path.split('/').pop());
    if (path.includes('/chats')) return chatsHandler.visit(path);
}

if (window.scriptInitialized) return; // in case of multiple script injections
window.scriptInitialized = true;

navigation.addEventListener('navigate', (event) => handlePath(new URL(event.destination.url).pathname));
handlePath(location.pathname);