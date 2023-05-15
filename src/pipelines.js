/**
 * @file Pipelines provide a high-level, easy to use, API for running machine learning models.
 * 
 * **Example:** Instantiate pipeline using the `pipeline` function.
 * ```javascript
 * import { pipeline } from '@xenova/transformers';
 * 
 * let pipeline = await pipeline('sentiment-analysis');
 * let result = await pipeline('I love transformers!');
 * // [{'label': 'POSITIVE', 'score': 0.999817686}]
 * ```
 * 
 * @module pipelines
 */

import {
    AutoTokenizer,
    PreTrainedTokenizer,
} from './tokenizers.js';
import {
    AutoModel,
    AutoModelForSequenceClassification,
    AutoModelForTokenClassification,
    AutoModelForQuestionAnswering,
    AutoModelForMaskedLM,
    AutoModelForSeq2SeqLM,
    AutoModelForCausalLM,
    AutoModelForVision2Seq,
    AutoModelForImageClassification,
    AutoModelForImageSegmentation,
    AutoModelForObjectDetection,
    PreTrainedModel,
} from './models.js';
import {
    AutoProcessor,
    Processor
} from './processors.js';


import {
    Callable,
    isString,
    dispatchCallback,
} from './utils/core.js';
import {
    softmax,
    max,
    getTopItems,
    cos_sim,
    dot
} from './utils/maths.js';
import {
    read_audio
} from './utils/audio.js';
import { Tensor } from './utils/tensor.js';
import { CustomImage } from './utils/image.js';

/**
 * Prepare images for further tasks.
 * @param {any[]} images images to prepare.
 * @returns {Promise<any[]>} returns processed images.
 * @private
 */
async function prepareImages(images) {
    if (!Array.isArray(images)) {
        images = [images];
    }

    // Possibly convert any non-images to images
    images = await Promise.all(images.map(x => CustomImage.read(x)));
    return images;
}

/**
 * The Pipeline class is the class from which all pipelines inherit.
 * Refer to this class for methods shared across different pipelines.
 * @extends Callable
 */
export class Pipeline extends Callable {
    /**
     * Create a new Pipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedTokenizer} tokenizer The tokenizer to use.
     * @param {PreTrainedModel} model The model to use.
     */
    constructor(task, tokenizer, model) {
        super();
        this.task = task;
        this.tokenizer = tokenizer;
        this.model = model;
    }

    /**
     * Disposes the model.
     * @returns {Promise<void>} A promise that resolves when the model has been disposed.
     */
    async dispose() {
        await this.model.dispose();
    }

    /**
     * Executes the task associated with the pipeline.
     * @param {any} texts The input texts to be processed.
     * @returns {Promise<any>} A promise that resolves to an array containing the inputs and outputs of the task.
     */
    async _call(texts) {
        // Run tokenization
        let inputs = this.tokenizer(texts, {
            padding: true,
            truncation: true
        });

        // Run model
        let outputs = await this.model(inputs)

        return [inputs, outputs];
    }
}

/**
 * Text classification pipeline using any `ModelForSequenceClassification`.
 * @extends Pipeline
 */
export class TextClassificationPipeline extends Pipeline {
    /**
     * Executes the text classification task.
     * @param {any} texts The input texts to be classified.
     * @param {Object} options An optional object containing the following properties:
     * @param {number} [options.topk=1] The number of top predictions to be returned.
     * @returns {Promise<Object[]|Object>} A promise that resolves to an array or object containing the predicted labels and scores.
     */
    async _call(texts, {
        topk = 1
    } = {}) {

        let [inputs, outputs] = await super._call(texts);

        let id2label = this.model.config.id2label;
        let toReturn = [];
        for (let batch of outputs.logits) {
            let scores = getTopItems(softmax(batch.data), topk);

            let vals = scores.map(function (x) {
                return {
                    label: id2label[x[0]],
                    score: x[1],
                }
            });
            if (topk === 1) {
                toReturn.push(...vals);
            } else {
                toReturn.push(vals);
            }
        }

        return Array.isArray(texts) || topk === 1 ? toReturn : toReturn[0];
    }
}


/**
 * Named Entity Recognition pipeline using any `ModelForTokenClassification`.
 * @extends Pipeline
 */
export class TokenClassificationPipeline extends Pipeline {
    /**
     * Executes the token classification task.
     * @param {any} texts The input texts to be classified.
     * @param {Object} options An optional object containing the following properties:
     * @returns {Promise<Object[]|Object>} A promise that resolves to an array or object containing the predicted labels and scores.
     */
    async _call(texts, {
        ignore_labels = ['O'], // TODO init param?
    } = {}) {

        let isBatched = Array.isArray(texts);

        if (!isBatched) {
            texts = [texts];
        }

        let tokenizer = this.tokenizer;
        let [inputs, outputs] = await super._call(texts);

        let logits = outputs.logits;
        let id2label = this.model.config.id2label;

        let toReturn = [];
        for (let i = 0; i < logits.dims[0]; ++i) {
            let ids = inputs.input_ids[i];
            let batch = logits[i];

            // List of tokens that aren't ignored
            let tokens = [];
            for (let j = 0; j < batch.dims[0]; ++j) {
                let tokenData = batch[j];
                let topScoreIndex = max(tokenData.data)[1];

                let entity = id2label[topScoreIndex];
                if (ignore_labels.includes(entity)) {
                    // We predicted a token that should be ignored. So, we skip it.
                    continue;
                }

                // TODO add option to keep special tokens?
                let word = tokenizer.decode([ids[j].item()], { skip_special_tokens: true });
                if (word === '') {
                    // Was a special token. So, we skip it.
                    continue;
                }

                let scores = softmax(tokenData.data);

                tokens.push({
                    entity: entity,
                    score: scores[topScoreIndex],
                    index: j,
                    word: word,

                    // TODO: null for now, but will add
                    start: null,
                    end: null,
                });
            }
            toReturn.push(tokens);
        }
        return isBatched ? toReturn : toReturn[0];
    }
}
/**
 * Question Answering pipeline using any `ModelForQuestionAnswering`.
 * @extends Pipeline
 */
export class QuestionAnsweringPipeline extends Pipeline {
    /**
     * Executes the question answering task.
     * @param {string|string[]} question The question(s) to be answered.
     * @param {string|string[]} context The context(s) where the answer(s) can be found.
     * @param {Object} options An optional object containing the following properties:
     * @param {number} [options.topk=1] The number of top answer predictions to be returned.
     * @returns {Promise<any>} A promise that resolves to an array or object containing the predicted answers and scores.
     */
    // @ts-ignore
    async _call(question, context, {
        topk = 1
    } = {}) {

        let inputs = this.tokenizer(question, {
            text_pair: context
        })

        let output = await this.model(inputs);

        let toReturn = [];
        for (let j = 0; j < output.start_logits.dims[0]; ++j) {
            let ids = inputs.input_ids[j];
            let sepIndex = ids.indexOf(this.tokenizer.sep_token_id);

            let s1 = Array.from(softmax(output.start_logits[j].data))
                .map((x, i) => [x, i])
                .filter(x => x[1] > sepIndex);
            let e1 = Array.from(softmax(output.end_logits[j].data))
                .map((x, i) => [x, i])
                .filter(x => x[1] > sepIndex);

            let options = product(s1, e1)
                .filter(x => x[0][1] <= x[1][1])
                .map(x => [x[0][1], x[1][1], x[0][0] * x[1][0]])
                .sort((a, b) => b[2] - a[2]);

            for (let k = 0; k < Math.min(options.length, topk); ++k) {
                let [start, end, score] = options[k];

                let answer_tokens = [...ids].slice(start, end + 1)

                let answer = this.tokenizer.decode(answer_tokens, {
                    skip_special_tokens: true,
                });

                // TODO add start and end?
                // NOTE: HF returns character index
                toReturn.push({
                    answer, score
                });
            }
        }

        // Mimic HF's return type based on topk
        return (topk === 1) ? toReturn[0] : toReturn;

    }
}

/**
 * Masked language modeling prediction pipeline using any `ModelWithLMHead`.
 * @extends Pipeline
 */
export class FillMaskPipeline extends Pipeline {
    /**
     * Fill the masked token in the text(s) given as inputs.
     * @param {any} texts The masked input texts.
     * @param {Object} options An optional object containing the following properties:
     * @param {number} [options.topk=5] The number of top predictions to be returned.
     * @returns {Promise<Object[]|Object>} A promise that resolves to an array or object containing the predicted tokens and scores.
     */
    async _call(texts, {
        topk = 5
    } = {}) {
        // Run tokenization
        let [inputs, outputs] = await super._call(texts);

        // Determine indices of mask tokens
        // let mask_token_indices = inputs.input_ids.data.map(x => )

        // let logits = reshape(outputs.logits.data, outputs.logits.dims);

        let tokenizer = this.tokenizer;

        let toReturn = [];

        for (let i = 0; i < inputs.input_ids.dims[0]; ++i) {
            let ids = inputs.input_ids[i];
            let mask_token_index = ids.indexOf(this.tokenizer.mask_token_id)

            if (mask_token_index === -1) {
                throw Error(`Mask token (${tokenizer.mask_token}) not found in text.`)
            }
            let logits = outputs.logits[i];
            let itemLogits = logits[mask_token_index];

            let scores = getTopItems(softmax(itemLogits.data), topk);

            toReturn.push(scores.map(x => {
                let sequence = [...ids];
                sequence[mask_token_index] = x[0];

                return {
                    score: x[1],
                    token: x[0],
                    token_str: tokenizer.model.vocab[x[0]],
                    sequence: tokenizer.decode(sequence, { skip_special_tokens: true }),
                }
            }));
        }
        return Array.isArray(texts) ? toReturn : toReturn[0];
    }
}

/**
 * Text2TextGenerationPipeline class for generating text using a model that performs text-to-text generation tasks.
 * @extends Pipeline
 */
export class Text2TextGenerationPipeline extends Pipeline {
    _key = null;

    /**
     * Fill the masked token in the text(s) given as inputs.
     * @param {string|string[]} texts The text or array of texts to be processed.
     * @param {Object} [options={}] Options for the fill-mask pipeline.
     * @param {number} [options.topk=5] The number of top-k predictions to return.
     * @returns {Promise<any>} An array of objects containing the score, predicted token, predicted token string,
     * and the sequence with the predicted token filled in, or an array of such arrays (one for each input text).
     * If only one input text is given, the output will be an array of objects.
     * @throws {Error} When the mask token is not found in the input text.
     */
    async _call(texts, generate_kwargs = {}) {
        if (!Array.isArray(texts)) {
            texts = [texts];
        }

        // Add global prefix, if present
        if (this.model.config.prefix) {
            texts = texts.map(x => this.model.config.prefix + x)
        }

        // Handle task specific params:
        let task_specific_params = this.model.config.task_specific_params
        if (task_specific_params && task_specific_params[this.task]) {
            // Add prefixes, if present
            if (task_specific_params[this.task].prefix) {
                texts = texts.map(x => task_specific_params[this.task].prefix + x)
            }

            // TODO update generation config
        }

        let tokenizer_options = {
            padding: true,
            truncation: true,
        }
        let input_ids;
        if (this instanceof TranslationPipeline && '_build_translation_inputs' in this.tokenizer) {
            // TODO: move to Translation pipeline?
            // Currently put here to avoid code duplication
            // @ts-ignore
            input_ids = this.tokenizer._build_translation_inputs(texts, tokenizer_options, generate_kwargs).input_ids;

        } else {
            input_ids = this.tokenizer(texts, tokenizer_options).input_ids;
        }

        let outputTokenIds = (await this.model.generate(input_ids, generate_kwargs)).flat();

        /**
         * @type {any[]}
         */
        let toReturn = this.tokenizer.batch_decode(outputTokenIds, {
            skip_special_tokens: true,
        });
        if (this._key !== null) {
            toReturn = toReturn.map(text => {
                return (this._key === null) ? text : { [this._key]: text }
            })
        }
        return toReturn
    }
}


/**
 * A pipeline for summarization tasks, inheriting from Text2TextGenerationPipeline.
 * @extends Text2TextGenerationPipeline
 */
export class SummarizationPipeline extends Text2TextGenerationPipeline {
    _key = 'summary_text';
}

/**
 * TranslationPipeline class to translate text from one language to another using the provided model and tokenizer.
 * @extends Text2TextGenerationPipeline
 */
export class TranslationPipeline extends Text2TextGenerationPipeline {
    _key = 'translation_text';
}

/**
 * Language generation pipeline using any `ModelWithLMHead`.
 * This pipeline predicts the words that will follow a specified text prompt.
 * @extends Pipeline
 */
export class TextGenerationPipeline extends Pipeline {
    /**
     * Generates text based on an input prompt.
     * @param {any} texts The input prompt or prompts to generate text from.
     * @param {Object} [generate_kwargs={}] Additional arguments for text generation.
     * @returns {Promise<any>} The generated text or texts.
     */
    async _call(texts, generate_kwargs = {}) {
        let stringInput = typeof texts === 'string' || texts instanceof String;
        if (stringInput) {
            texts = [texts];
        }

        this.tokenizer.padding_side = 'left';
        let inputs = this.tokenizer(texts, {
            padding: true,
            truncation: true,
        });

        let input_ids = inputs.input_ids;
        let attention_mask = inputs.attention_mask;

        /**
         * @type {any[]}
         */
        let outputTokenIds = await this.model.generate(input_ids, generate_kwargs, null, {
            inputs_attention_mask: attention_mask
        });

        let toReturn = outputTokenIds.map((outTokens, i) => {
            let startText = texts[i].trim();
            let decoded = this.tokenizer.batch_decode(outTokens, {
                skip_special_tokens: true,
            }).map(x => {
                return {
                    generated_text: startText + x
                }
            });

            return decoded
        });

        return (stringInput && toReturn.length === 1) ? toReturn[0] : toReturn;
    }
}

/**
 * NLI-based zero-shot classification pipeline using a `ModelForSequenceClassification`
 * trained on NLI (natural language inference) tasks. Equivalent of `text-classification`
 * pipelines, but these models don't require a hardcoded number of potential classes, they
 * can be chosen at runtime. It usually means it's slower but it is **much** more flexible.
 * @extends Pipeline
 */
export class ZeroShotClassificationPipeline extends Pipeline {

    /**
     * Create a new ZeroShotClassificationPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedTokenizer} tokenizer The tokenizer to use.
     * @param {PreTrainedModel} model The model to use.
     */
    constructor(task, tokenizer, model) {
        super(task, tokenizer, model);

        // Use model config to get label2id mapping
        this.label2id = Object.fromEntries(
            Object.entries(this.model.config.label2id).map(
                ([k, v]) => [k.toLowerCase(), v]
            )
        );

        this.entailment_id = this.label2id['entailment'];
        if (this.entailment_id === undefined) {
            console.warn("Could not find 'entailment' in label2id mapping. Using 2 as entailment_id.");
            this.entailment_id = 2;
        }

        this.contradiction_id = this.label2id['contradiction'];
        if (this.contradiction_id === undefined) {
            console.warn("Could not find 'contradiction' in label2id mapping. Using 0 as contradiction_id.");
            this.contradiction_id = 0;
        }
    }
    /**
     * @param {any[]} texts
     * @param {string[]} candidate_labels
     * @param {Object} options Additional options:
     * @param {string} [options.hypothesis_template="This example is {}."] The template used to turn each
     * candidate label into an NLI-style hypothesis. The candidate label will replace the {} placeholder.
     * @param {boolean} [options.multi_label=false] Whether or not multiple candidate labels can be true.
     * If `false`, the scores are normalized such that the sum of the label likelihoods for each sequence
     * is 1. If `true`, the labels are considered independent and probabilities are normalized for each
     * candidate by doing a softmax of the entailment score vs. the contradiction score.
     * @return {Promise<Object|Object[]>} The prediction(s), as a map (or list of maps) from label to score.
     */
    // @ts-ignore
    async _call(texts, candidate_labels, {
        hypothesis_template = "This example is {}.",
        multi_label = false,
    } = {}) {

        let isBatched = Array.isArray(texts);

        if (!isBatched) {
            texts = [texts];
        }
        if (!Array.isArray(candidate_labels)) {
            candidate_labels = [candidate_labels];
        }

        // Insert labels into hypothesis template
        let hypotheses = candidate_labels.map(
            x => hypothesis_template.replace('{}', x)
        );

        // How to perform the softmax over the logits:
        //  - true:  softmax over the entailment vs. contradiction dim for each label independently
        //  - false: softmax the "entailment" logits over all candidate labels
        let softmaxEach = multi_label || candidate_labels.length === 1;

        let toReturn = [];
        for (let premise of texts) {
            let entails_logits = [];

            for (let hypothesis of hypotheses) {
                let inputs = this.tokenizer(premise, {
                    text_pair: hypothesis,
                })
                let outputs = await this.model(inputs)

                if (softmaxEach) {
                    entails_logits.push([
                        outputs.logits.data[this.contradiction_id],
                        outputs.logits.data[this.entailment_id]
                    ])
                } else {
                    entails_logits.push(outputs.logits.data[this.entailment_id])
                }
            }

            let scores;
            if (softmaxEach) {
                scores = entails_logits.map(x => softmax(x)[1]);
            } else {
                scores = softmax(entails_logits);
            }

            // Sort by scores (desc) and return scores with indices
            let scores_sorted = scores
                .map((x, i) => [x, i])
                .sort((a, b) => {
                    return b[0] - a[0];
                });

            toReturn.push({
                sequence: premise,
                labels: scores_sorted.map(x => candidate_labels[x[1]]),
                scores: scores_sorted.map(x => x[0]),
            });
        }
        return isBatched ? toReturn : toReturn[0];
    }
}


/**
 * Feature extraction pipeline using no model head. This pipeline extracts the hidden
 * states from the base transformer, which can be used as features in downstream tasks.
 * 
 * This can be used with `sentence-transformers`. If you want to get the raw outputs
 * from the model, use `AutoModel.from_pretrained(...)`.
 * @extends Pipeline
 * 
 * @todo Make sure this works for other models than `sentence-transformers`.
 */
export class FeatureExtractionPipeline extends Pipeline {
    /**
     * Private method to perform mean pooling of the last hidden state followed by a normalization step.
     * @param {Tensor} last_hidden_state Tensor of shape [batchSize, seqLength, embedDim]
     * @param {Tensor} attention_mask Tensor of shape [batchSize, seqLength]
     * @returns {Tensor} Returns a new Tensor of shape [batchSize, embedDim].
     * @private
     */
    _mean_pooling(last_hidden_state, attention_mask) {
        // last_hidden_state: [batchSize, seqLength, embedDim]
        // attention_mask:    [batchSize, seqLength]

        let shape = [last_hidden_state.dims[0], last_hidden_state.dims[2]];
        let returnedData = new last_hidden_state.data.constructor(shape[0] * shape[1])
        let [batchSize, seqLength, embedDim] = last_hidden_state.dims;

        let outIndex = 0;
        for (let i = 0; i < batchSize; ++i) {
            let offset = i * embedDim * seqLength;

            for (let k = 0; k < embedDim; ++k) {
                let sum = 0;
                let count = 0;

                let attnMaskOffset = i * seqLength;
                let offset2 = offset + k;
                // Pool over all words in sequence
                for (let j = 0; j < seqLength; ++j) {
                    // index into attention mask
                    let attn = Number(attention_mask.data[attnMaskOffset + j]);

                    count += attn;
                    sum += last_hidden_state.data[offset2 + j * embedDim] * attn;
                }

                let avg = sum / count;
                returnedData[outIndex++] = avg;
            }
        }

        return new Tensor(
            last_hidden_state.type,
            returnedData,
            shape
        )
    }

    /**
     * Private method to normalize the input tensor along dim=1. 
     * NOTE: only works for tensors of shape [batchSize, embedDim]. Operates in-place.
     * @param {any} tensor Tensor of shape [batchSize, embedDim]
     * @returns {any} Returns the same Tensor object after performing normalization.
     * @private
     */
    _normalize(tensor) {
        for (let batch of tensor) {
            let norm = Math.sqrt(batch.data.reduce((a, b) => a + b * b, 0))

            for (let i = 0; i < batch.data.length; ++i) {
                batch.data[i] /= norm;
            }
        }
        return tensor;
    }

    /**
     * Method to perform mean pooling and normalization of the input texts.
     * @param {string[]} texts An array of texts to embed.
     * @returns {Promise<Tensor>} Returns a new Tensor of shape [batchSize, embedDim].
     */
    async _call(texts) {
        let [inputs, outputs] = await super._call(texts);

        // Perform mean pooling, followed by a normalization step
        return this._normalize(this._mean_pooling(outputs.last_hidden_state, inputs.attention_mask));
    }

    /**
     * @param {number[]} arr1
     * @param {number[]} arr2
     */
    cos_sim(arr1, arr2, is_normalised = false) {
        // Compute cosine similarity. If `is_normalised`, then
        // use the dot product instead of the cosine similarity
        return is_normalised ? dot(arr1, arr2) : cos_sim(arr1, arr2);
    }
}

/**
 * Pipeline that aims at extracting spoken text contained within some audio.
 * @extends Pipeline
 */
export class AutomaticSpeechRecognitionPipeline extends Pipeline {

    /**
     * Create a new AutomaticSpeechRecognitionPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedTokenizer} tokenizer The tokenizer to use.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, tokenizer, model, processor) {
        super(task, tokenizer, model);
        this.processor = processor;
    }

    /**
     * Preprocesses the input audio for the AutomaticSpeechRecognitionPipeline.
     * @param {any} audio The audio to be preprocessed.
     * @param {number} sampling_rate The sampling rate of the audio.
     * @returns {Promise<string | ArrayBuffer>} A promise that resolves to the preprocessed audio data.
     * @private
     */
    async _preprocess(audio, sampling_rate) {
        if (isString(audio)) {
            audio = await read_audio(audio, sampling_rate);
        }

        return audio;
    }

    /**
     * Asynchronously processes audio and generates text transcription using the model.
     * @param {Array} audio The audio to be transcribed. Can be a single Float32Array or an array of Float32Arrays.
     * @param {Object} [kwargs={}] Optional arguments.
     * @param {boolean} [kwargs.return_timestamps] Whether to return timestamps or not. Default is false.
     * @param {number} [kwargs.chunk_length_s] The length of audio chunks to process in seconds. Default is 0 (no chunking).
     * @param {number} [kwargs.stride_length_s] The length of overlap between consecutive audio chunks in seconds. If not provided, defaults to chunk_length_s / 6.
     * @param {function} [kwargs.chunk_callback] Callback function to be called with each chunk processed.
     * @param {boolean} [kwargs.force_full_sequences] Whether to force outputting full sequences or not. Default is false.
     * @returns {Promise<Object>} A Promise that resolves to an object containing the transcription text and optionally timestamps if return_timestamps is true.
     */
    async _call(audio, kwargs = {}) {
        let return_timestamps = kwargs.return_timestamps ?? false;
        let chunk_length_s = kwargs.chunk_length_s ?? 0;
        let stride_length_s = kwargs.stride_length_s ?? null;
        let chunk_callback = kwargs.chunk_callback ?? null;
        let force_full_sequences = kwargs.force_full_sequences ?? false;

        // TODO
        // task = 'transcribe',
        // language = 'en',

        let single = !Array.isArray(audio)
        if (single) {
            audio = [audio]
        }

        const sampling_rate = this.processor.feature_extractor.config.sampling_rate;
        const time_precision = this.processor.feature_extractor.config.chunk_length / this.model.config.max_source_positions;

        let toReturn = [];
        for (let aud of audio) {
            aud = await this._preprocess(aud, sampling_rate)

            /** @type {any[]} */
            let chunks = [];
            if (chunk_length_s > 0) {
                if (stride_length_s === null) {
                    stride_length_s = chunk_length_s / 6;
                } else if (chunk_length_s <= stride_length_s) {
                    throw Error("`chunk_length_s` must be larger than `stride_length_s`.")
                }

                // TODO support different stride_length_s (for left and right)

                const window = sampling_rate * chunk_length_s;
                const stride = sampling_rate * stride_length_s;
                const jump = window - 2 * stride;
                let offset = 0;

                // Create subarrays of audio with overlaps

                while (offset < aud.length) {
                    let subarr = aud.subarray(offset, offset + window);
                    let feature = await this.processor(subarr);

                    let isFirst = offset === 0;
                    let isLast = offset + jump >= aud.length;
                    chunks.push({
                        stride: [
                            subarr.length,
                            isFirst ? 0 : stride,
                            isLast ? 0 : stride
                        ],
                        input_features: feature.input_features,
                        is_last: isLast
                    })
                    offset += jump;
                }

            } else {
                chunks = [{
                    stride: [aud.length, 0, 0],
                    input_features: (await this.processor(aud)).input_features,
                    is_last: true
                }]
            }

            // Generate for each set of input features
            for (let chunk of chunks) {
                // NOTE: doing sequentially for now
                let data = await this.model.generate(chunk.input_features, kwargs);

                // Get top beam
                chunk.tokens = data[0].flat()

                // convert stride to seconds
                chunk.stride = chunk.stride.map(x => x / sampling_rate);

                if (chunk_callback !== null) {
                    chunk_callback(chunk)
                }
            }

            // Merge text chunks
            // @ts-ignore
            let [full_text, optional] = this.tokenizer._decode_asr(chunks, {
                time_precision: time_precision,
                return_timestamps: return_timestamps,
                force_full_sequences: force_full_sequences
            });

            toReturn.push({ text: full_text, ...optional })
        }
        return single ? toReturn[0] : toReturn;
    }
}

/**
 * Image To Text pipeline using a `AutoModelForVision2Seq`. This pipeline predicts a caption for a given image.
 * @extends Pipeline
 */
export class ImageToTextPipeline extends Pipeline {
    /**
     * Create a new ImageToTextPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedTokenizer} tokenizer The tokenizer to use.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, tokenizer, model, processor) {
        super(task, tokenizer, model);
        this.processor = processor;
    }

    /**
     * Assign labels to the image(s) passed as inputs.
     * @param {any[]} images The images to be captioned.
     * @param {Object} [generate_kwargs={}] Optional generation arguments.
     * @returns {Promise<Object|Object[]>} A Promise that resolves to an object (or array of objects) containing the generated text(s).
     */
    async _call(images, generate_kwargs = {}) {
        let isBatched = Array.isArray(images);

        images = await prepareImages(images);

        let pixel_values = (await this.processor(images)).pixel_values;

        let toReturn = [];
        for (let batch of pixel_values) {
            batch.dims = [1, ...batch.dims]
            let output = (await this.model.generate(batch, generate_kwargs)).flat();
            let decoded = this.tokenizer.batch_decode(output, {
                skip_special_tokens: true,
            }).map(x => {
                return { generated_text: x.trim() }
            })
            toReturn.push(decoded);
        }

        return isBatched ? toReturn : toReturn[0];
    }
}

/**
 * Image classification pipeline using any `AutoModelForImageClassification`.
 * This pipeline predicts the class of an image.
 * @extends Pipeline
 */
export class ImageClassificationPipeline extends Pipeline {
    /**
     * Create a new ImageClassificationPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, model, processor) {
        super(task, null, model); // TODO tokenizer
        this.processor = processor;
    }

    /**
     * Classify the given images.
     * @param {any} images The images to classify.
     * @param {Object} options The options to use for classification.
     * @param {number} [options.topk=1] The number of top results to return.
     * @returns {Promise<any>} The top classification results for the images.
     */
    async _call(images, {
        topk = 1
    } = {}) {
        let isBatched = Array.isArray(images);
        images = await prepareImages(images);

        let inputs = await this.processor(images);
        let output = await this.model(inputs);

        let id2label = this.model.config.id2label;
        let toReturn = [];
        for (let batch of output.logits) {
            let scores = getTopItems(softmax(batch.data), topk);

            let vals = scores.map(function (x) {
                return {
                    label: id2label[x[0]],
                    score: x[1],
                }
            });
            if (topk === 1) {
                toReturn.push(...vals);
            } else {
                toReturn.push(vals);
            }
        }

        return isBatched || topk === 1 ? toReturn : toReturn[0];
    }

}

/**
 * Image segmentation pipeline using any `AutoModelForXXXSegmentation`.
 * This pipeline predicts masks of objects and their classes.
 * @extends Pipeline
 */
export class ImageSegmentationPipeline extends Pipeline {
    /**
     * Create a new ImageSegmentationPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, model, processor) {
        super(task, null, model); // TODO tokenizer
        this.processor = processor;

        this.subtasks_mapping = {
            // Mapping of subtasks to their corresponding post-processing function names.
            panoptic: 'post_process_panoptic_segmentation',
            instance: 'post_process_instance_segmentation',
            semantic: 'post_process_semantic_segmentation'
        }
    }

    /**
     * Segment the input images.
     * @param {Array} images The input images.
     * @param {Object} options The options to use for segmentation.
     * @param {number} [options.threshold=0.5] Probability threshold to filter out predicted masks.
     * @param {number} [options.mask_threshold=0.5] Threshold to use when turning the predicted masks into binary values.
     * @param {number} [options.overlap_mask_area_threshold=0.8] Mask overlap threshold to eliminate small, disconnected segments.
     * @param {null|string} [options.subtask=null] Segmentation task to be performed. One of [`panoptic`, `instance`, and `semantic`], depending on model capabilities. If not set, the pipeline will attempt to resolve (in that order).
     * @param {Array} [options.label_ids_to_fuse=null] List of label ids to fuse. If not set, do not fuse any labels.
     * @param {Array} [options.target_sizes=null] List of target sizes for the input images. If not set, use the original image sizes.
     * @returns {Promise<Array>} The annotated segments.
     */
    async _call(images, {
        threshold = 0.5,
        mask_threshold = 0.5,
        overlap_mask_area_threshold = 0.8,
        label_ids_to_fuse = null,
        target_sizes = null,
        subtask = null, // TODO use
    } = {}) {
        let isBatched = Array.isArray(images);

        if (isBatched && images.length !== 1) {
            throw Error("Image segmentation pipeline currently only supports a batch size of 1.");
        }

        images = await prepareImages(images);
        let imageSizes = images.map(x => [x.height, x.width]);

        let inputs = await this.processor(images);
        let output = await this.model(inputs);

        let fn = null;
        if (subtask !== null) {
            fn = this.subtasks_mapping[subtask];
        } else {
            for (let [task, func] of Object.entries(this.subtasks_mapping)) {
                if (func in this.processor.feature_extractor) {
                    fn = this.processor.feature_extractor[func].bind(this.processor.feature_extractor);
                    subtask = task;
                    break;
                }
            }
        }

        // add annotations
        let annotation = [];

        if (subtask === 'panoptic' || subtask === 'instance') {

            let processed = fn(
                output,
                threshold,
                mask_threshold,
                overlap_mask_area_threshold,
                label_ids_to_fuse,
                target_sizes ?? imageSizes, // TODO FIX?
            )[0];

            let segmentation = processed.segmentation;
            let id2label = this.model.config.id2label;

            for (let segment of processed.segments_info) {
                let maskData = new Uint8ClampedArray(segmentation.data.length);
                for (let i = 0; i < segmentation.data.length; ++i) {
                    if (segmentation.data[i] === segment.id) {
                        maskData[i] = 255;
                    }
                }

                let mask = new CustomImage(maskData, segmentation.dims[1], segmentation.dims[0], 1)

                annotation.push({
                    score: segment.score,
                    label: id2label[segment.label_id],
                    mask: mask
                })
            }

        } else if (subtask === 'semantic') {
            throw Error(`semantic segmentation not yet supported.`);

        } else {
            throw Error(`Subtask ${subtask} not supported.`);
        }

        return annotation;
    }
}


/**
 * Zero shot image classification pipeline. This pipeline predicts the class of
 * an image when you provide an image and a set of `candidate_labels`.
 * @extends Pipeline
 */
export class ZeroShotImageClassificationPipeline extends Pipeline {

    /**
     * Create a new ZeroShotImageClassificationPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedTokenizer} tokenizer The tokenizer to use.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, tokenizer, model, processor) {
        super(task, tokenizer, model);
        this.processor = processor;
    }

    /**
     * Classify the input images with candidate labels using a zero-shot approach.
     * @param {Array} images The input images.
     * @param {Array} candidate_labels The candidate labels.
     * @param {Object} options The options for the classification.
     * @param {string} [options.hypothesis_template] The hypothesis template to use for zero-shot classification. Default: "This is a photo of {}".
     * @returns {Promise<any>} An array of classifications for each input image or a single classification object if only one input image is provided.
     */
    // @ts-ignore
    async _call(images, candidate_labels, {
        hypothesis_template = "This is a photo of {}"
    } = {}) {
        let isBatched = Array.isArray(images);
        images = await prepareImages(images);

        // Insert label into hypothesis template 
        let texts = candidate_labels.map(
            x => hypothesis_template.replace('{}', x)
        );

        // Run tokenization
        let text_inputs = this.tokenizer(texts, {
            padding: true,
            truncation: true
        });

        // Compare each image with each candidate label
        let image_inputs = await this.processor(images);
        let output = await this.model({ ...text_inputs, ...image_inputs });

        let toReturn = [];
        for (let batch of output.logits_per_image) {
            // Compute softmax per image
            let probs = softmax(batch.data);

            toReturn.push([...probs].map((x, i) => {
                return {
                    score: x,
                    label: candidate_labels[i]
                }
            }));
        }

        return isBatched ? toReturn : toReturn[0];
    }
}

/**
 * Object detection pipeline using any `AutoModelForObjectDetection`.
 * This pipeline predicts bounding boxes of objects and their classes.
 * @extends Pipeline
 */
export class ObjectDetectionPipeline extends Pipeline {
    /**
     * Create a new ObjectDetectionPipeline.
     * @param {string} task The task of the pipeline. Useful for specifying subtasks.
     * @param {PreTrainedModel} model The model to use.
     * @param {Processor} processor The processor to use.
     */
    constructor(task, model, processor) {
        super(task, null, model); // TODO tokenizer
        this.processor = processor;
    }

    /**
     * Detect objects (bounding boxes & classes) in the image(s) passed as inputs.
     * @param {any[]} images The input images.
     * @param {Object} options The options for the object detection.
     * @param {number} [options.threshold=0.9] The threshold used to filter boxes by score.
     * @param {boolean} [options.percentage=false] Whether to return the boxes coordinates in percentage (true) or in pixels (false).
     */
    async _call(images, {
        threshold = 0.9,
        percentage = false,
    } = {}) {
        let isBatched = Array.isArray(images);

        if (isBatched && images.length !== 1) {
            throw Error("Object detection pipeline currently only supports a batch size of 1.");
        }
        images = await prepareImages(images);

        let imageSizes = percentage ? null : images.map(x => [x.height, x.width]);

        let inputs = await this.processor(images);
        let output = await this.model(inputs);

        // @ts-ignore
        let processed = this.processor.feature_extractor.post_process_object_detection(output, threshold, imageSizes);

        // Add labels
        let id2label = this.model.config.id2label;
        processed.forEach(x => x.labels = x.classes.map(y => id2label[y]));

        return isBatched ? processed : processed[0];
    }
}

const SUPPORTED_TASKS = {
    "text-classification": {
        "tokenizer": AutoTokenizer,
        "pipeline": TextClassificationPipeline,
        "model": AutoModelForSequenceClassification,
        "default": {
            // TODO: replace with original
            // "model": "distilbert-base-uncased-finetuned-sst-2-english",
            "model": "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
        },
        "type": "text",
    },
    "token-classification": {
        "tokenizer": AutoTokenizer,
        "pipeline": TokenClassificationPipeline,
        "model": AutoModelForTokenClassification,
        "default": {
            // TODO: replace with original
            // "model": "Davlan/bert-base-multilingual-cased-ner-hrl",
            "model": "Xenova/bert-base-multilingual-cased-ner-hrl",
        },
        "type": "text",
    },
    "question-answering": {
        "tokenizer": AutoTokenizer,
        "pipeline": QuestionAnsweringPipeline,
        "model": AutoModelForQuestionAnswering,
        "default": {
            // TODO: replace with original
            // "model": "distilbert-base-cased-distilled-squad",
            "model": "Xenova/distilbert-base-cased-distilled-squad",
        },
        "type": "text",
    },

    "fill-mask": {
        "tokenizer": AutoTokenizer,
        "pipeline": FillMaskPipeline,
        "model": AutoModelForMaskedLM,
        "default": {
            // TODO: replace with original
            // "model": "bert-base-uncased",
            "model": "Xenova/bert-base-uncased",
        },
        "type": "text",
    },
    "summarization": {
        "tokenizer": AutoTokenizer,
        "pipeline": SummarizationPipeline,
        "model": AutoModelForSeq2SeqLM,
        "default": {
            // TODO: replace with original
            // "model": "sshleifer/distilbart-cnn-6-6",
            "model": "Xenova/distilbart-cnn-6-6",
        },
        "type": "text",
    },
    "translation": {
        "tokenizer": AutoTokenizer,
        "pipeline": TranslationPipeline,
        "model": AutoModelForSeq2SeqLM,
        "default": {
            // TODO: replace with original
            // "model": "t5-small",
            "model": "Xenova/t5-small",
        },
        "type": "text",
    },
    "text2text-generation": {
        "tokenizer": AutoTokenizer,
        "pipeline": Text2TextGenerationPipeline,
        "model": AutoModelForSeq2SeqLM,
        "default": {
            // TODO: replace with original
            // "model": "google/flan-t5-small",
            "model": "Xenova/flan-t5-small",
        },
        "type": "text",
    },
    "text-generation": {
        "tokenizer": AutoTokenizer,
        "pipeline": TextGenerationPipeline,
        "model": AutoModelForCausalLM,
        "default": {
            // TODO: replace with original
            // "model": "gpt2",
            "model": "Xenova/gpt2",
        },
        "type": "text",
    },
    "zero-shot-classification": {
        "tokenizer": AutoTokenizer,
        "pipeline": ZeroShotClassificationPipeline,
        "model": AutoModelForSequenceClassification,
        "default": {
            // TODO: replace with original
            // "model": "typeform/distilbert-base-uncased-mnli",
            "model": "Xenova/distilbert-base-uncased-mnli",
        },
        "type": "text",
    },

    "automatic-speech-recognition": {
        "tokenizer": AutoTokenizer,
        "pipeline": AutomaticSpeechRecognitionPipeline,
        "model": AutoModelForSeq2SeqLM,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "openai/whisper-tiny.en",
            "model": "Xenova/whisper-tiny.en",
        },
        "type": "multimodal",
    },

    "image-to-text": {
        "tokenizer": AutoTokenizer,
        "pipeline": ImageToTextPipeline,
        "model": AutoModelForVision2Seq,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "nlpconnect/vit-gpt2-image-captioning",
            "model": "Xenova/vit-gpt2-image-captioning",
        },
        "type": "multimodal",
    },

    "image-classification": {
        // no tokenizer
        "pipeline": ImageClassificationPipeline,
        "model": AutoModelForImageClassification,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "google/vit-base-patch16-224",
            "model": "Xenova/vit-base-patch16-224",
        },
        "type": "multimodal",
    },

    "image-segmentation": {
        // no tokenizer
        "pipeline": ImageSegmentationPipeline,
        "model": AutoModelForImageSegmentation,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "facebook/detr-resnet-50-panoptic",
            "model": "Xenova/detr-resnet-50-panoptic",
        },
        "type": "multimodal",
    },

    "zero-shot-image-classification": {
        // no tokenizer
        "tokenizer": AutoTokenizer,
        "pipeline": ZeroShotImageClassificationPipeline,
        "model": AutoModel,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "openai/clip-vit-base-patch32",
            "model": "Xenova/clip-vit-base-patch32",
        },
        "type": "multimodal",
    },

    "object-detection": {
        // no tokenizer
        "pipeline": ObjectDetectionPipeline,
        "model": AutoModelForObjectDetection,
        "processor": AutoProcessor,
        "default": {
            // TODO: replace with original
            // "model": "facebook/detr-resnet-50",
            "model": "Xenova/detr-resnet-50",
        },
        "type": "multimodal",
    },

    // This task serves as a useful interface for dealing with sentence-transformers (https://huggingface.co/sentence-transformers).
    "feature-extraction": {
        "tokenizer": AutoTokenizer,
        "pipeline": FeatureExtractionPipeline,
        "model": AutoModel,
        "default": {
            // TODO: replace with original
            // "model": "sentence-transformers/all-MiniLM-L6-v2",
            "model": "Xenova/all-MiniLM-L6-v2",
        },
        "type": "text",
    },
}


const TASK_ALIASES = {
    "sentiment-analysis": "text-classification",
    "ner": "token-classification",
    "vqa": "visual-question-answering",

    // Add for backwards compatibility
    "embeddings": "feature-extraction",
}

/**
 * @typedef {import('./utils/hub.js').PretrainedOptions} PretrainedOptions
 */

/**
 * Utility factory method to build a [`Pipeline`] object.
 *
 * @param {string} task The task of the pipeline.
 * @param {string} [model=null] The name of the pre-trained model to use. If not specified, the default model for the task will be used.
 * @param {PretrainedOptions} [options] Optional parameters for the pipeline.
 * @returns {Promise<Pipeline>} A Pipeline object for the specified task.
 * @throws {Error} If an unsupported pipeline is requested.
 */
export async function pipeline(
    task,
    model = null,
    {
        quantized = true,
        progress_callback = null,
        config = null,
        cache_dir = null,
        local_files_only = false,
        revision = 'main',
    } = {}
) {
    // Helper method to construct pipeline

    // Apply aliases
    task = TASK_ALIASES[task] ?? task;

    // Get pipeline info
    let pipelineInfo = SUPPORTED_TASKS[task.split('_', 1)[0]];
    if (!pipelineInfo) {
        throw Error(`Unsupported pipeline: ${task}. Must be one of [${Object.keys(SUPPORTED_TASKS)}]`)
    }

    // Use model if specified, otherwise, use default
    if (!model) {
        model = pipelineInfo.default.model
        console.log(`No model specified. Using default model: "${model}".`);
    }

    let tokenizerClass = pipelineInfo.tokenizer;
    let modelClass = pipelineInfo.model;
    let pipelineClass = pipelineInfo.pipeline;
    let processorClass = pipelineInfo.processor;

    let promises = [];

    let pretrainedOptions = {
        quantized,
        progress_callback,
        config,
        cache_dir,
        local_files_only,
        revision,
    }
    if (tokenizerClass) {
        promises.push(
            tokenizerClass.from_pretrained(model, pretrainedOptions),
        )
    }
    if (modelClass) {
        promises.push(
            modelClass.from_pretrained(model, pretrainedOptions)
        )
    }

    if (processorClass) {
        promises.push(
            processorClass.from_pretrained(model, pretrainedOptions)
        )
    }

    // Load tokenizer and model
    let items = await Promise.all(promises)
    // TODO: fix error below

    dispatchCallback(progress_callback, {
        'status': 'ready',
        'task': task,
        'model': model,
    });

    return new pipelineClass(task, ...items);

}

/**
 * Compute the Cartesian product of given arrays
 * @param {...Array} a Arrays to compute the product
 * @returns {Array} Returns the computed Cartesian product as an array
 * @private
 */
function product(...a) {
    // Cartesian product of items
    // Adapted from https://stackoverflow.com/a/43053803
    return a.reduce((a, b) => a.flatMap(d => b.map(e => [d, e])));
}
