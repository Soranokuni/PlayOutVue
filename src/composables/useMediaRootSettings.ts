import { computed, ref, watch, type Ref } from 'vue';
import { useMediaRootStore } from '../stores/mediaRoot';
import {
    describeMediaRoot,
    proposedLocalRoot,
    sameFolder,
    shouldOfferCasparFix,
    type MediaRootStatus,
} from '../lib/mediaRootStatus';

/**
 * MEDIA-FALLBACK-HANDOFF AE-1, Settings → Media. The draft *Local media path*
 * is checked against the transcoder's registry marker. A loopback transcoder
 * gets its folder proposed; a remote one needs this PC's view of the folder
 * (UNC path or mapped drive) and a Verify. Fix acts on the saved root only.
 */
export function useMediaRootSettings(draftRoot: Ref<string>, savedRoot: () => string) {
    const mediaRoot = useMediaRootStore();
    const result = ref<MediaRootStatus | null>(mediaRoot.status);
    const verifying = ref(false);
    const verifyError = ref('');

    const view = computed(() => describeMediaRoot(result.value));
    const advert = computed(() => result.value?.advertised ?? null);
    const proposal = computed(() => proposedLocalRoot(result.value, draftRoot.value));
    const isRemote = computed(() => !!result.value && !result.value.transcoder_local);
    const resultIsForDraft = computed(() => !!result.value && sameFolder(result.value.local_root, draftRoot.value));
    const canFix = computed(() =>
        shouldOfferCasparFix(mediaRoot.status) && sameFolder(mediaRoot.status?.local_root, savedRoot()),
    );

    async function verify() {
        verifying.value = true;
        verifyError.value = '';
        try {
            result.value = await mediaRoot.probe(draftRoot.value || '');
        } catch (error) {
            verifyError.value = String((error as any)?.message ?? error);
        } finally {
            verifying.value = false;
        }
    }

    function useProposal() {
        if (!proposal.value) return;
        draftRoot.value = proposal.value;
        void verify();
    }

    watch(() => mediaRoot.status, (next) => {
        if (next && sameFolder(next.local_root, draftRoot.value)) result.value = next;
    });

    return { mediaRoot, result, verifying, verifyError, view, advert, proposal, isRemote, resultIsForDraft, canFix, verify, useProposal };
}
