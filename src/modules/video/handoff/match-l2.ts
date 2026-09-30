/** L2 打分与转写调用已搬进本体的统一比对器（1b §2）；旧交接模块照旧从这里引用 */
export { bigramSeq, CLIP_SECONDS, idfTable, MATCH_ASR_TIMEOUT_MS, MIN_SPEECH_CHARS, scoreTranscript, speechChars, windowSimilarity } from "../../production/match/l2.js";
export { funasrTranscriber, type MatchTranscriber, type TranscribeOutcome } from "../../production/match/transcribe.js";
