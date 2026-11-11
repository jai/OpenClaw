/**
 * Host-set message action param that marks a message-tool send as progress
 * (`final: false`). Channel actions read it when the trusted turn context is
 * unavailable on their execution path. Models cannot set it: the message tool
 * deletes any supplied value before adding its own.
 */
export const SOURCE_REPLY_PROGRESS_PARAM = "openclawSourceReplyProgress";
