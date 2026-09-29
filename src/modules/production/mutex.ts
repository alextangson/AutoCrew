/** 文件归属事务互斥住在 storage（NAS 归档也要用）；这里只转出 */
export { holdsFileOwnership, withFileOwnership } from "../../storage/file-ownership.js";
