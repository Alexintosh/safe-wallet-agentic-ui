// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
// Disposable test fixture only; no production deployment path.
contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function transfer(address recipient, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[recipient] += amount; return true; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
}
