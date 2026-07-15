export interface FileNode {
  name:      string;
  path:      string;
  type:      'file' | 'dir';
  ext?:      string;
  size?:     number;
  children?: FileNode[];
}
