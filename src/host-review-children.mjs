import { createChildFollowupAdmission, isChildFollowupCapacityError } from './child-followup-admission.mjs';
import { ChildInputCapacityError } from './child-capacity-error.mjs';
import { randomUUID } from 'node:crypto';
import { buildReviewChildPrompt, buildReviewChildOutputSchema } from './child-input-budget.mjs';
import { parseRetrievalResponse, executeRetrievalBatch } from './retrieval-protocol.mjs';
import { registerReviewChild } from './review-child-broker.mjs';

export const REVIEW_CHILD_PRESET = 'dsh-code-review-restricted';
const failure = (code, message) => Object.assign(new Error(message), { code });
// One managed spawn activation owns the entire primary loop, including snapshot tools.
// No credentials or free-form filesystem tools are passed into that activation.
export function createHostReviewChildren(ctx) {
  let ready, unregisterPreset;
  const service = () => ctx.get?.('subagents');
  const presets = () => ctx.get?.('agentPresets');
  function capability() {
    const runtime = service(), provider = runtime?.getProvider?.('spawn');
    return !!(provider?.capabilities?.outputSchema && provider.capabilities.agentPreset && provider.capabilities.agentOptions && runtime.resolveMaxDepth && presets()?.register && ctx.get?.('agents')?.get);
  }
  async function prepare() {
    if (!capability()) throw failure('REVIEW_SUBAGENTS_UNAVAILABLE', 'Restricted host spawn subagents are unavailable; no hidden direct fallback');
    ready ??= presets().register({ id: REVIEW_CHILD_PRESET, name: 'Read-only snapshot review', plugins: [
      { name: '@deepseek-ai/dsh-tool-executor-native' },
      { name: '@feng0531/dsh-code-review/child' },
    ] }).then(dispose => { unregisterPreset = dispose; });
    await ready;
  }
  return { capability, prepare,
    async create({ parent, route, cwd, signal }) {
      await prepare(); signal.throwIfAborted();
      const runtime = service(), childId = randomUUID();
      let handle, revoked, stop, started = false;
      const child = { transport: 'host-subagent', childId,
        retrievalTelemetry: Object.freeze({ version: 1, complete: true, scope: 'schema-authorization-range' }),
        async runPrimary({ request, scope, maxRounds, maxInputBytes, reserveModelCall, onRetrieved, onBudgetLimited, onTruncated, onProgress, onChildStarted, onRetrievalProtocolError, onRetrievalProtocolUnobserved, onCapacityFinalOnly }) {
          if (started) throw new Error('A review child cannot be reused for another primary');
          started = true; let rounds = 0, modelCalls = 0, bindingFatal;
          const admission=createChildFollowupAdmission({maxInputBytes});
          const supplemental = used => ({usedRounds:used,maxRounds,remainingRounds:Math.max(0,maxRounds-used),finalResponseRequired:used>=maxRounds||admission.finalOnly(),notice:used>=maxRounds||admission.finalOnly()?'No supplemental reads remain. Submit structured_output using supplied evidence; explicitly retain unresolved dependencies as limitations.':'Prioritize concrete unresolved dependencies; provided primary bodies need not be reread for receipts.'});
          const capacityNotice=()=>({snapshotId:JSON.parse(request.input).snapshotId,results:[],deliveryStatus:'not-delivered-capacity-policy',supplementalRetrieval:supplemental(rounds),capacityPolicy:admission.summary()});
          const abortBinding = error => { bindingFatal ??= error; handle?.dispose().catch(() => {}); };
          const assertAgent = agent => {
            if (!agent || agent.id !== childId || agent.session.header.parentSession !== (parent.session.header.id ?? parent.id) || agent.session.header.agentPreset !== REVIEW_CHILD_PRESET) throw failure('REVIEW_CHILD_IDENTITY', 'Review child ownership changed');
          };
          const binding = { parent, parentId: parent.session.header.id ?? parent.id, presetId: REVIEW_CHILD_PRESET, route, assertAgent, onFatal: abortBinding,
            beforeModelCall(options) {
              try {
                signal.throwIfAborted();
                if (bindingFatal) throw bindingFatal;
                if (options.provider !== route.provider || options.model !== route.model || options.reasoningEffort !== route.reasoningEffort) throw failure('REVIEW_CHILD_ROUTE', 'Review child model route changed');
                // This is the complete logical LLM envelope, not provider-specific HTTP bytes.
                const bytes = Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }));
                if (bytes > maxInputBytes) throw new ChildInputCapacityError(bytes,maxInputBytes,{unsent:modelCalls===0});
                if (modelCalls >= maxRounds + 2) throw failure('WHOLE_SCOPE_MODEL_CALL_LIMIT', 'Child primary loop call limit exceeded');
                admission.observe(options);
                reserveModelCall(); modelCalls++;
              } catch (error) { abortBinding(error); throw error; }
            },
            executeRequests(args, exec) {
              assertAgent(exec.agent); signal.throwIfAborted();
              if (bindingFatal) throw bindingFatal;
              let requests;
              try{requests=parseRetrievalResponse(args);}catch(error){signal.throwIfAborted();onRetrievalProtocolError?.({code:'RETRIEVAL_PROTOCOL_ERROR',category:'invalid-schema'});throw error;}
              if(admission.finalOnly()){onRetrievalProtocolUnobserved?.({code:'RETRIEVAL_VALIDATION_NOT_OBSERVED'});return capacityNotice();}
              if (rounds >= maxRounds) {
                onRetrievalProtocolUnobserved?.({code:'RETRIEVAL_VALIDATION_NOT_OBSERVED'});
                const info = { code: 'RETRIEVAL_ROUND_BUDGET_EXCEEDED', reason: 'Child snapshot tool rounds exhausted' };
                onBudgetLimited?.(info); throw failure(info.code, info.reason);
              }
              try {
                const allowed = new Set(scope.catalog().map(source => source.id));
                if (requests.some(operation => operation.kind === 'read' ? !allowed.has(operation.id) : operation.sourceIds?.some(id => !allowed.has(id)))) throw new Error('Source not authorized');
                scope.preflight(requests);
                let delivery;
                const results = scope.transaction(() => {
                  const rows=executeRetrievalBatch(args,scope,signal);
                  delivery={snapshotId:JSON.parse(request.input).snapshotId,results:rows,budget:scope.budget(),supplementalRetrieval:supplemental(rounds+1)};
                  admission.admit(delivery);
                  return rows;
                });
                rounds++;
                for (const { request: operation, result } of results) {
                  if (result.truncated) onTruncated?.();
                  onRetrieved?.([{ kind: operation.kind, snapshotId: result.snapshotId, stage: 'retrieved-locally', sourceId: result.sourceId, hash: result.hash, start: result.start, count: result.count, resultBytes: Buffer.byteLength(JSON.stringify(result)) }]);
                }
                return delivery;
              } catch (error) {
                signal.throwIfAborted();
                const category = error.message === 'Source not authorized' || error.message === 'Invalid search source filter' ? 'unauthorized-source' : ['Invalid line range','Line range outside source'].includes(error.message) ? 'invalid-range' : undefined;
                if (category) onRetrievalProtocolError?.({code:'RETRIEVAL_PROTOCOL_ERROR',category});
                if(isChildFollowupCapacityError(error)){onCapacityFinalOnly?.({childId,code:'CHILD_FOLLOWUP_CAPACITY',requiredBytes:error.requiredBytes,approvedCap:maxInputBytes});onBudgetLimited?.({code:error.code,reason:'Supplemental source result not delivered under child capacity policy'});return capacityNotice();}
                if (['READER_CALL_BUDGET_EXCEEDED','READER_OUTPUT_BUDGET_EXCEEDED'].includes(error.code)) onBudgetLimited?.({code:error.code,reason:error.message});
                throw error;
              }
            },
          };
          revoked = registerReviewChild(childId, binding);
          const schema = buildReviewChildOutputSchema(request);
          stop = () => { handle?.dispose().catch(() => {}); }; signal.addEventListener('abort', stop, { once: true });
          try {
            handle = await runtime.startActivation({ provider: 'spawn', childId, label: 'Whole-scope review batch', request: {
              parent, cwd, agentPreset: REVIEW_CHILD_PRESET, maxDepth: runtime.resolveMaxDepth(undefined),
              agentOptions: { ...route, maxTokens: 4096 }, outputSchema: schema,
              prompt: [{ type: 'text', text:buildReviewChildPrompt(request,scope) }],
            }, signal, delivery: 'caller' });
            onChildStarted?.({childId,transport:'host-subagent'});
            if (signal.aborted || bindingFatal) await handle.dispose();
            const result = await handle.result;
            signal.throwIfAborted(); if (bindingFatal) throw bindingFatal;
            if (result.stopReason !== 'completed' || !result.structured) throw failure('REVIEW_CHILD_INCOMPLETE', 'Host child did not commit a structured final result');
            await onProgress?.({stage:'host-child-complete',childId,modelCalls});
            return result.structured;
          } catch (error) { throw bindingFatal ?? error; } finally { signal.removeEventListener('abort', stop); }
        },
        async dispose() { revoked?.(); if (handle) await handle.dispose(); },
      };
      return child;
    },
    async dispose() { if (ready) await ready; await unregisterPreset?.(); },
  };
}
